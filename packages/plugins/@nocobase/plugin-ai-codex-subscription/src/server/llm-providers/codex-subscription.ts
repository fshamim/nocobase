import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { extractChatGptAccountId, refreshCodexAccessToken } from '../auth/codex-oauth';
import { loadCodexCredentials, saveCodexCredentials } from '../auth/store';
import type { AppLike, StoredCodexCredentials } from '../auth/store';

type LLMProviderApp = AppLike & {
  environment?: {
    renderJsonTemplate?: (value: unknown) => unknown;
  };
  logger?: {
    error?: (...args: unknown[]) => void;
  };
};

type LLMProviderOptions = {
  app: LLMProviderApp;
  serviceOptions?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
};

type LLMProviderMeta = {
  title: string;
  provider: new (options: LLMProviderOptions) => CodexSubscriptionProvider;
};

type CodexSubscriptionServiceOptions = {
  apiKey?: string;
  llmServiceName?: string;
  mockMode?: boolean;
  mockResponse?: string;
  baseURL?: string;
};

type CodexSubscriptionModelOptions = {
  llmService?: string;
  model?: string;
  timeoutMs?: number;
  responseFormat?: string;
};

type ChatMessage = {
  role: string;
  content: string;
};

type CodexToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: 'tool_call';
};

type CodexCompletion = {
  content: string;
  toolCalls?: CodexToolCall[];
};

type CodexSubscriptionChatModelOptions = {
  app: LLMProviderOptions['app'];
  serviceOptions: CodexSubscriptionServiceOptions;
  modelOptions: CodexSubscriptionModelOptions;
  tools?: unknown[];
  structuredOutput?: unknown;
  systemPrompt?: string;
};

type CodexResponseInputMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{
    type: 'input_text' | 'output_text';
    text: string;
  }>;
};

type CodexResponsesRequest = {
  model: string;
  store: false;
  stream: true;
  instructions: string;
  input: CodexResponseInputMessage[];
  tools: unknown[];
  tool_choice: 'auto' | 'none';
  parallel_tool_calls: boolean;
  include: string[];
  text?: {
    verbosity: 'low';
  };
};

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const STATIC_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'openai-codex'];

export class CodexSubscriptionCredentialBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSubscriptionCredentialBlockedError';
  }
}

export class CodexSubscriptionChatModel extends BaseChatModel {
  private readonly options: CodexSubscriptionChatModelOptions;

  constructor(options: CodexSubscriptionChatModelOptions) {
    super({});
    this.options = options;
  }

  _llmType() {
    return 'codex-subscription';
  }

  async _generate(messages: any[]) {
    const completion = await this.complete(messages);
    return {
      generations: [
        {
          text: completion.content,
          message: new AIMessage({
            content: completion.content,
            tool_calls: completion.toolCalls,
            response_metadata: {
              provider: 'codex-subscription',
              model: this.options.modelOptions.model ?? DEFAULT_MODEL,
              credentialMode: this.options.serviceOptions.mockMode ? 'mock' : 'oauth',
            },
          }),
        },
      ],
      llmOutput: {},
    };
  }

  bindTools(tools: unknown[]) {
    return new CodexSubscriptionChatModel({ ...this.options, tools });
  }

  withConfig(config: Record<string, unknown>) {
    return new CodexSubscriptionChatModel({
      ...this.options,
      modelOptions: { ...this.options.modelOptions, ...config },
    });
  }

  private async complete(messages: unknown[] | unknown): Promise<CodexCompletion> {
    const { serviceOptions, modelOptions } = this.options;
    if (serviceOptions.mockMode) {
      return { content: serviceOptions.mockResponse ?? 'Mock Codex subscription response.' };
    }

    const credentials = await this.getConnectedCredentials();
    const controller = new AbortController();
    const timeoutMs = validTimeout(modelOptions.timeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const request = buildRequestBody({
      model: modelOptions.model ?? DEFAULT_MODEL,
      messages: toChatMessages(messages),
      tools: this.options.tools ?? [],
      systemPrompt: this.options.systemPrompt,
      responseFormat: modelOptions.responseFormat,
    });

    try {
      const accountId = resolveChatGptAccountId(credentials);
      const response = await fetch(resolveCodexResponsesUrl(serviceOptions.baseURL), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.accessToken}`,
          'chatgpt-account-id': accountId,
          'OpenAI-Beta': 'responses=experimental',
          originator: 'nocobase',
        },
        body: JSON.stringify(request),
      });
      const body = await response.text();
      const json = body ? parseJsonSafely(body) : {};
      if (!response.ok) {
        throw new Error(
          `Codex subscription request failed with status ${response.status}${
            safeErrorMessage(json) ? `: ${safeErrorMessage(json)}` : ''
          }.`,
        );
      }
      const isSse = isCodexSseBody(body);
      try {
        return isSse ? extractCompletionFromSse(body) : extractCompletion(json);
      } catch (error) {
        const detail = isSse ? summarizeCodexSse(body) : summarizeCodexJson(json);
        throw new Error(`${(error as Error).message} ${detail}`.trim());
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Codex subscription request timed out after ${timeoutMs}ms.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactSecretMaterial(message, [credentials.accessToken, credentials.refreshToken]));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getConnectedCredentials(): Promise<StoredCodexCredentials> {
    const llmServiceName = resolveServiceName(this.options.serviceOptions, this.options.modelOptions);
    const stored = await loadCodexCredentials(this.options.app, llmServiceName);
    if (!stored) {
      throw new CodexSubscriptionCredentialBlockedError(
        `Codex subscription provider credential-blocked: connect ${llmServiceName} to ChatGPT first.`,
      );
    }
    if (!stored.refreshToken) {
      throw new CodexSubscriptionCredentialBlockedError(
        `Codex subscription provider credential-blocked: ${llmServiceName} is missing a refresh token.`,
      );
    }
    if (!stored.accessToken || !stored.accountId) {
      throw new CodexSubscriptionCredentialBlockedError(
        `Codex subscription provider credential-blocked: ${llmServiceName} is missing OAuth token material.`,
      );
    }

    if (!needsRefresh(stored.expiresAt)) {
      return stored;
    }

    const refreshed = await refreshCodexAccessToken(stored.refreshToken);
    const updated: StoredCodexCredentials = {
      llmServiceName,
      accountId: refreshed.accountId,
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      connectedAt: stored.connectedAt,
      lastVerifiedAt: new Date().toISOString(),
    };
    await saveCodexCredentials(this.options.app, updated);
    return updated;
  }
}

export class CodexSubscriptionProvider {
  app: LLMProviderOptions['app'];
  serviceOptions: Record<string, unknown>;
  modelOptions: Record<string, unknown>;
  chatModel: CodexSubscriptionChatModel;

  constructor(options: LLMProviderOptions) {
    this.app = options.app;
    this.serviceOptions = renderOptions(this.app, options.serviceOptions || {});
    this.modelOptions = options.modelOptions || {};
    this.chatModel = this.createModel();
  }

  createModel() {
    return new CodexSubscriptionChatModel({
      app: this.app,
      serviceOptions: this.serviceOptions as CodexSubscriptionServiceOptions,
      modelOptions: this.modelOptions as CodexSubscriptionModelOptions,
    });
  }

  prepareChain(context: Record<string, unknown>) {
    let chain: any = new CodexSubscriptionChatModel({
      app: this.app,
      serviceOptions: this.serviceOptions as CodexSubscriptionServiceOptions,
      modelOptions: this.modelOptions as CodexSubscriptionModelOptions,
      systemPrompt: typeof context?.systemPrompt === 'string' ? context.systemPrompt : undefined,
    });
    const tools = Array.isArray(context?.tools) ? context.tools : [];
    if (tools.length > 0) {
      chain = chain.bindTools(tools);
    }
    if (context?.structuredOutput) {
      chain = chain.withStructuredOutput(context.structuredOutput);
    }
    return chain;
  }

  async invoke(context: Record<string, unknown>, options?: unknown) {
    return this.prepareChain(context).invoke(context?.messages ?? [], options);
  }

  async stream(context: Record<string, unknown>, options?: unknown) {
    return this.prepareChain(context).streamEvents(context?.messages ?? [], options);
  }

  async testFlight(): Promise<{ status: 'success' | 'error'; code: number; message?: string }> {
    try {
      await this.chatModel.invoke([{ role: 'user', content: 'Reply with exactly: connected.' }]);
      return { status: 'success', code: 0 };
    } catch (error) {
      return { status: 'error', code: 1, message: this.parseResponseError(error) };
    }
  }

  parseResponseMessage(message: Record<string, unknown>) {
    return {
      key: message?.messageId ?? message?.id,
      content: message?.content,
      role: message?.role,
    };
  }

  parseResponseChunk(chunk: unknown) {
    return chunk;
  }

  async parseAttachment(_ctx: unknown, attachment: Record<string, unknown>) {
    const filename = typeof attachment?.filename === 'string' ? attachment.filename : 'attachment';
    const mimetype = typeof attachment?.mimetype === 'string' ? attachment.mimetype : 'unknown file';
    return {
      placement: 'system',
      content: `The user uploaded ${filename} (${mimetype}). The Codex subscription provider does not support attachment parsing in this MVP. Ask the user to paste the relevant text instead.`,
    };
  }

  parseResponseMetadata() {
    return [null, null];
  }

  parseWebSearchAction() {
    return [];
  }

  parseReasoningContent() {
    return null;
  }

  resolveTools(tools: unknown[]) {
    return tools || [];
  }

  builtInTools() {
    return [];
  }

  isToolConflict() {
    return false;
  }

  async listModels(): Promise<{ models?: { id: string }[]; code?: number; errMsg?: string }> {
    const serviceOptions = this.serviceOptions as CodexSubscriptionServiceOptions;
    if (serviceOptions.mockMode) {
      return { models: [{ id: 'codex-subscription-mock' }] };
    }
    const configured = [
      serviceOptions.llmServiceName,
      (this.modelOptions as CodexSubscriptionModelOptions).model,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const uniqueModels = Array.from(new Set([...STATIC_MODELS, ...configured]));
    return { models: uniqueModels.map((id) => ({ id })) };
  }

  parseResponseError(error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error ?? 'Unexpected Codex subscription provider error.');
    return redactSecretMaterial(message);
  }
}

export const codexSubscriptionProviderOptions: LLMProviderMeta = {
  title: 'Codex/ChatGPT subscription',
  provider: CodexSubscriptionProvider,
};

function renderOptions(app: LLMProviderOptions['app'], options: Record<string, unknown>) {
  return (app.environment?.renderJsonTemplate?.(options) as Record<string, unknown>) || options;
}

function resolveServiceName(
  serviceOptions: CodexSubscriptionServiceOptions,
  modelOptions: CodexSubscriptionModelOptions,
): string {
  const llmServiceName =
    (typeof modelOptions.llmService === 'string' && modelOptions.llmService.trim()) ||
    (typeof serviceOptions.llmServiceName === 'string' && serviceOptions.llmServiceName.trim());
  if (!llmServiceName) {
    throw new CodexSubscriptionCredentialBlockedError(
      'Codex subscription provider credential-blocked: save the LLM service before connecting it to ChatGPT.',
    );
  }
  return llmServiceName;
}

function resolveCodexResponsesUrl(baseURL: unknown): string {
  const raw = typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL.trim() : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/codex')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

function validTimeout(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 300_000)
    : DEFAULT_TIMEOUT_MS;
}

function toChatMessages(messages: unknown[] | unknown): ChatMessage[] {
  const list = Array.isArray(messages) ? messages : [messages];
  return list.map((message) => {
    const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    return {
      role:
        typeof record.role === 'string'
          ? record.role
          : typeof record._getType === 'function'
            ? String(record._getType())
            : 'user',
      content: extractMessageContent(record.content ?? message),
    };
  });
}

function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(extractMessageContent).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (typeof record.content === 'string') {
      return record.content;
    }
  }
  return String(content ?? '');
}

function buildRequestBody(input: {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  systemPrompt?: string;
  responseFormat?: string;
}): CodexResponsesRequest {
  const instructions = [
    input.systemPrompt?.trim(),
    input.responseFormat === 'json_object' ? 'Return a valid JSON object.' : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n');

  const hasToolResult = input.messages.some((message) => message.role === 'tool');
  const tools = hasToolResult ? [] : toCodexTools(input.tools);
  return {
    model: input.model,
    store: false,
    stream: true,
    instructions: instructions || 'You are a helpful assistant.',
    input: input.messages
      .filter((message) => message.content.trim().length > 0 && message.role !== 'system')
      .map((message) => ({
        type: 'message',
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [
          {
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: message.role === 'tool' ? `Tool result:\n${message.content}` : message.content,
          },
        ],
      })),
    tools,
    tool_choice: hasToolResult ? 'none' : 'auto',
    parallel_tool_calls: !hasToolResult,
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  };
}

function toCodexTools(tools: unknown[]): unknown[] {
  return tools
    .map((tool) => {
      const converted = convertToOpenAITool(tool as never) as Record<string, unknown>;
      const fn = converted.function as Record<string, unknown> | undefined;
      if (converted.type === 'function' && fn) {
        return {
          type: 'function',
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters ?? {},
          strict: false,
        };
      }
      return converted;
    })
    .filter((tool) => {
      const record = tool as Record<string, unknown>;
      return record.type === 'function' && typeof record.name === 'string' && record.name.length > 0;
    });
}

function isCodexSseBody(body: string) {
  return body.split('\n').some((line) => line.trimStart().startsWith('data:'));
}

function extractCompletionFromSse(body: string): CodexCompletion {
  let outputText = '';
  let completedResponse: Record<string, unknown> | undefined;
  const completedItems: Record<string, unknown>[] = [];
  const toolCalls: CodexToolCall[] = [];

  for (const event of parseCodexSseEvents(body)) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (
      (type === 'response.output_text.delta' || type === 'response.output_text.done') &&
      typeof event.delta === 'string'
    ) {
      outputText += event.delta;
    }
    if (type === 'response.output_text.done' && typeof event.text === 'string' && outputText.length === 0) {
      outputText = event.text;
    }
    if (type === 'response.output_item.done' && typeof event.item === 'object' && event.item !== null) {
      const item = event.item as Record<string, unknown>;
      completedItems.push(item);
      const toolCall = toCodexToolCall(item);
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }
    if (type === 'response.completed' && typeof event.response === 'object' && event.response !== null) {
      completedResponse = event.response as Record<string, unknown>;
    }
    if (type === 'response.failed') {
      const response = event.response as Record<string, unknown> | undefined;
      const error = response?.error as Record<string, unknown> | undefined;
      throw new Error(`Codex response failed: ${String(error?.message ?? error?.code ?? JSON.stringify(event))}`);
    }
    if (type === 'error') {
      throw new Error(`Codex stream error: ${safeErrorMessage(event) || JSON.stringify(event)}`);
    }
  }

  if (toolCalls.length > 0) {
    return { content: outputText, toolCalls };
  }
  if (outputText.trim().length > 0) {
    return { content: outputText };
  }
  if (completedItems.length > 0) {
    return extractCompletion({ output: completedItems });
  }
  if (completedResponse) {
    return extractCompletion(completedResponse);
  }
  throw new Error('Codex subscription stream did not include message content.');
}

function parseCodexSseEvents(body: string) {
  const events: Record<string, unknown>[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    events.push(parseJsonSafely(payload));
  }
  return events;
}

function summarizeCodexSse(body: string) {
  const events = parseCodexSseEvents(body);
  const types = [...new Set(events.map((event) => String(event.type ?? 'unknown')))];
  const itemTypes = [
    ...new Set(
      events
        .map((event) => event.item)
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => String(item.type ?? 'unknown')),
    ),
  ];
  return `Codex response summary: eventTypes=${types.join(',') || 'none'}; itemTypes=${itemTypes.join(',') || 'none'}.`;
}

function summarizeCodexJson(json: Record<string, unknown>) {
  return `Codex response summary: jsonKeys=${Object.keys(json).join(',') || 'none'}.`;
}

function extractCompletion(json: Record<string, unknown>): CodexCompletion {
  if (typeof json.output_text === 'string' && json.output_text.trim().length > 0) {
    return { content: json.output_text };
  }

  const output = json.output;
  if (Array.isArray(output)) {
    const toolCalls = output
      .map((item) =>
        typeof item === 'object' && item !== null ? toCodexToolCall(item as Record<string, unknown>) : null,
      )
      .filter((toolCall): toolCall is CodexToolCall => Boolean(toolCall));
    if (toolCalls.length > 0) {
      return { content: '', toolCalls };
    }

    const text = output
      .flatMap((item) => {
        const content =
          typeof item === 'object' && item !== null ? (item as Record<string, unknown>).content : undefined;
        return Array.isArray(content) ? content : [];
      })
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item !== 'object' || item === null) {
          return '';
        }
        const record = item as Record<string, unknown>;
        if (typeof record.text === 'string') {
          return record.text;
        }
        const nestedText = record.text as Record<string, unknown> | undefined;
        return typeof nestedText?.value === 'string' ? nestedText.value : '';
      })
      .filter((value) => value.length > 0)
      .join('\n');
    if (text) {
      return { content: text };
    }
  }

  const choiceMessage = (json.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
    | Record<string, unknown>
    | undefined;
  if (typeof choiceMessage?.content === 'string') {
    return { content: choiceMessage.content };
  }
  if (typeof json.content === 'string') {
    return { content: json.content };
  }
  throw new Error('Codex subscription response did not include message content.');
}

function toCodexToolCall(item: Record<string, unknown>): CodexToolCall | null {
  if (item.type !== 'function_call' || typeof item.name !== 'string') {
    return null;
  }
  const rawArguments = typeof item.arguments === 'string' && item.arguments.length > 0 ? item.arguments : '{}';
  const parsedArguments = parseJsonSafely(rawArguments);
  return {
    id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : item.name,
    name: item.name,
    args: parsedArguments,
    type: 'tool_call',
  };
}

function parseJsonSafely(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { message: body };
  }
}

function safeErrorMessage(json: Record<string, unknown>) {
  const error = json.error;
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, string>).message;
  }
  if (typeof json.message === 'string') {
    return json.message;
  }
  const serialized = JSON.stringify(json);
  return serialized === '{}' ? '' : serialized;
}

function resolveChatGptAccountId(credentials: StoredCodexCredentials) {
  const accountId = credentials.accountId || extractChatGptAccountId(credentials.accessToken);
  if (!accountId) {
    throw new CodexSubscriptionCredentialBlockedError(
      `Codex subscription provider credential-blocked: ${credentials.llmServiceName} is missing ChatGPT account id.`,
    );
  }
  return accountId;
}

function redactSecretMaterial(message: string, secrets: string[] = []) {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(session|token|cookie)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}

function needsRefresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return true;
  }
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }
  return timestamp <= Date.now() + 60_000;
}
