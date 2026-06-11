import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import {
  EcobaseDailyOperationsBriefService,
  type DailyEvidencePack,
  type DataWarningEvidence,
  type GenerateDailyOperationsBriefEvidenceParams,
} from './daily-operations-brief-service';

type PlainRecord = Record<string, unknown>;
type DailyBriefNarrativeStatus = 'ready_to_send' | 'blocked_delivery_configuration' | 'blocked_ai_provider_unavailable' | 'blocked_ai_response_invalid' | 'blocked_ai_validation_failed';
type DailyBriefValidationStatus = 'passed' | 'failed';

type GenerateDailyOperationsBriefParams = GenerateDailyOperationsBriefEvidenceParams & {
  aiEmployeeUsername?: string;
  llmService?: string;
  model?: string;
  maxBodyCharacters?: number;
};

type EcoNarrativeResponse = {
  subject: string;
  bodyMarkdown: string;
  citedEvidenceIds: string[];
  dataWarningsMentioned: string[];
  confidence: 'high' | 'medium' | 'low';
};

type EcoNarrativeProviderInput = {
  systemPrompt: string;
  userPrompt: string;
  repairPrompt?: string;
  llmService: string;
  model: string;
};

export interface EcoNarrativeProvider {
  generate(input: EcoNarrativeProviderInput): Promise<string>;
}

type AppLike = {
  pm?: {
    get?: (name: string) => unknown;
  };
};

type AiPluginLike = {
  aiManager?: {
    getLLMService?: (options: { llmService: string; model: string }) => Promise<{ provider?: { invoke?: (context: { messages: Array<{ role: 'system' | 'user'; content: string }> }, options?: unknown) => Promise<unknown> } }>;
  };
};

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bodyStructureForFocus(focus: DailyEvidencePack['focus']) {
  if (focus === 'buybox') return ['# Ecobase Daily Operations Brief', 'Opening summary', '## Buy Box recovery action', '## Impact and products', '## Secondary watch list', '## Data warnings', 'Bottom line'];
  if (focus === 'velocity') return ['# Ecobase Daily Operations Brief', 'Opening summary', '## Velocity investigation', '## Products and impact', '## Secondary watch list', '## Data warnings', 'Bottom line'];
  if (focus === 'profit_gap') return ['# Ecobase Daily Operations Brief', 'Opening summary', '## Profit gap action', '## Products and impact', '## Secondary watch list', '## Data warnings', 'Bottom line'];
  if (focus === 'okr') return ['# Ecobase Daily Operations Brief', 'Opening summary', '## Accountability/OKR attention', '## Owners and stale work', '## Secondary watch list', '## Data warnings', 'Bottom line'];
  if (focus === 'source_quality') return ['# Ecobase Daily Operations Brief', 'Opening summary', '## Data-confidence warning', '## Affected outputs', '## Safe actions today', '## Data warnings', 'Bottom line'];
  return ['# Ecobase Daily Operations Brief', 'Opening summary', '## Action today', '## Supplier/order follow-up', '## Watch list', '## Data warnings', 'Bottom line'];
}

function sanitizeForPrompt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForPrompt);
  if (!isRecord(value)) return value;
  const output: PlainRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (/secret|token|password|credential|authorization|apikey|apiKey|url/i.test(key)) continue;
    output[key] = sanitizeForPrompt(child);
  }
  return output;
}

function extractTextFromAiResponse(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  const content = value.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part)) return asString(part.text) ?? asString(part.content) ?? '';
      return '';
    }).filter(Boolean).join('\n');
  }
  return asString(value.text) ?? asString(value.output_text) ?? '';
}

function parseNarrativeJson(raw: string): EcoNarrativeResponse | { error: string } {
  try {
    const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) return { error: 'Eco response JSON root must be an object.' };
    const subject = asString(parsed.subject);
    const bodyMarkdown = asString(parsed.bodyMarkdown);
    const citedEvidenceIds = Array.isArray(parsed.citedEvidenceIds) ? parsed.citedEvidenceIds.map(asString).filter((item): item is string => Boolean(item)) : [];
    const dataWarningsMentioned = Array.isArray(parsed.dataWarningsMentioned) ? parsed.dataWarningsMentioned.map(asString).filter((item): item is string => Boolean(item)) : [];
    const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low' ? parsed.confidence : 'low';
    if (!subject) return { error: 'Eco response is missing subject.' };
    if (!bodyMarkdown) return { error: 'Eco response is missing bodyMarkdown.' };
    return { subject, bodyMarkdown, citedEvidenceIds, dataWarningsMentioned, confidence };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Eco response was not valid JSON.' };
  }
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownToText(markdown: string) {
  return markdown
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function markdownToHtml(markdown: string) {
  return markdown.split('\n').map((line) => {
    if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
    if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.trim().length === 0) return '';
    return `<p>${escapeHtml(line)}</p>`;
  }).join('\n');
}

function collectEvidenceIds(pack: DailyEvidencePack) {
  return new Set([
    ...pack.sourceStatus.map((item) => item.evidenceId),
    ...pack.inventoryRisks.map((item) => item.evidenceId),
    ...pack.supplierOrderContext.map((item) => item.evidenceId),
    ...pack.leadTimeIssues.map((item) => item.evidenceId),
    ...pack.dataWarnings.map((item) => item.evidenceId),
  ]);
}

function collectKnownValues(pack: DailyEvidencePack) {
  const asins = new Set<string>();
  const skus = new Set<string>();
  const orders = new Set<string>();
  const dates = new Set<string>([pack.date, pack.generatedAt.slice(0, 10)]);
  const moneyValues = new Set<string>();
  const addDate = (value: unknown) => {
    const text = asString(value);
    if (text && /^\d{4}-\d{2}-\d{2}/.test(text)) dates.add(text.slice(0, 10));
  };
  const addMoney = (value: unknown) => {
    const number = asNumber(value);
    if (number !== undefined) {
      moneyValues.add(String(Math.round(number)));
      moneyValues.add(number.toFixed(2));
    }
  };
  for (const risk of pack.inventoryRisks) {
    if (risk.asin) asins.add(risk.asin.toUpperCase());
    if (risk.sku) skus.add(risk.sku.toUpperCase());
    if (risk.supplierOrderRef) orders.add(risk.supplierOrderRef.toUpperCase());
    addDate(risk.estimatedOosDate);
    addDate(risk.latestSafeReorderDate);
    addMoney(risk.estimatedProfitRisk);
  }
  for (const order of pack.supplierOrderContext) {
    if (order.externalOrderRef) orders.add(order.externalOrderRef.toUpperCase());
    if (order.supplierOrderId) orders.add(order.supplierOrderId.toUpperCase());
    addDate(order.orderDate);
    addDate(order.expectedDeliveryDate);
    addDate(order.lastMeaningfulUpdateAt);
    for (const line of order.relatedProducts) {
      if (line.asin) asins.add(line.asin.toUpperCase());
      if (line.sku) skus.add(line.sku.toUpperCase());
      addDate(line.expectedSellableDate);
    }
  }
  for (const leadTime of pack.leadTimeIssues) {
    if (leadTime.asin) asins.add(leadTime.asin.toUpperCase());
    if (leadTime.sku) skus.add(leadTime.sku.toUpperCase());
    addDate(leadTime.leadTimeConfirmedAt);
  }
  for (const warning of pack.dataWarnings) {
    if (warning.asin) asins.add(warning.asin.toUpperCase());
    if (warning.sku) skus.add(warning.sku.toUpperCase());
  }
  return { asins, skus, orders, dates, moneyValues };
}

function tokens(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].map((match) => match[0].toUpperCase());
}

function warningMentioned(warning: DataWarningEvidence, response: EcoNarrativeResponse) {
  const narrative = `${response.subject}\n${response.bodyMarkdown}\n${response.dataWarningsMentioned.join('\n')}`.toLowerCase();
  return narrative.includes(warning.evidenceId.toLowerCase()) || narrative.includes(warning.code.toLowerCase()) || narrative.includes(warning.message.slice(0, 36).toLowerCase());
}

export class NocoBaseEcoNarrativeProvider implements EcoNarrativeProvider {
  constructor(private app?: AppLike) {}

  async generate(input: EcoNarrativeProviderInput) {
    const plugin = this.app?.pm?.get?.('ai') as AiPluginLike | undefined;
    const service = await plugin?.aiManager?.getLLMService?.({ llmService: input.llmService, model: input.model });
    if (!service?.provider?.invoke) {
      throw new Error(`Ecobase daily operations brief failed: AI provider ${input.llmService}/${input.model} is unavailable.`);
    }
    return extractTextFromAiResponse(await service.provider.invoke({
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.repairPrompt ?? input.userPrompt },
      ],
    }));
  }
}

export class NarrativeGroundingValidator {
  validate(pack: DailyEvidencePack, response: EcoNarrativeResponse, maxBodyCharacters = 8000) {
    const errors: string[] = [];
    const evidenceIds = collectEvidenceIds(pack);
    const known = collectKnownValues(pack);
    const narrative = `${response.subject}\n${response.bodyMarkdown}`;

    if (!response.subject.trim()) errors.push('Narrative subject is required.');
    if (!response.bodyMarkdown.trim()) errors.push('Narrative bodyMarkdown is required.');
    if (response.bodyMarkdown.length > maxBodyCharacters) errors.push(`Narrative bodyMarkdown exceeds ${maxBodyCharacters} characters.`);

    for (const id of response.citedEvidenceIds) {
      if (!evidenceIds.has(id)) errors.push(`Narrative cited unsupported evidence id ${id}.`);
    }
    for (const asin of tokens(narrative, /\bB0[A-Z0-9]{6,8}\b/gi)) {
      if (!known.asins.has(asin)) errors.push(`Narrative referenced unsupported ASIN ${asin}.`);
    }
    for (const orderRef of tokens(narrative, /\b(?:PO|RH)[A-Z0-9-]{2,}\b/gi)) {
      if (!known.orders.has(orderRef)) errors.push(`Narrative referenced unsupported supplier order ${orderRef}.`);
    }
    for (const date of [...narrative.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0])) {
      if (!known.dates.has(date)) errors.push(`Narrative referenced unsupported date ${date}.`);
    }
    for (const money of [...narrative.matchAll(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g)].map((match) => match[1])) {
      if (!known.moneyValues.has(String(Math.round(Number(money)))) && !known.moneyValues.has(Number(money).toFixed(2))) {
        errors.push(`Narrative referenced unsupported dollar value $${money}.`);
      }
    }
    for (const warning of pack.dataWarnings.filter((item) => item.severity === 'warning')) {
      if (!warningMentioned(warning, response)) errors.push(`Narrative omitted required data warning ${warning.code}.`);
    }
    if (/secret:\/\/|bearer\s+[a-z0-9._-]+|token=|api[_-]?key/i.test(narrative)) {
      errors.push('Narrative contains credential-like text.');
    }
    return { validationStatus: errors.length ? 'failed' as DailyBriefValidationStatus : 'passed' as DailyBriefValidationStatus, validationErrors: errors };
  }
}

export class EcobaseDailyOperationsBriefNarrativeService {
  constructor(
    private db: EcobaseDatabase,
    private provider: EcoNarrativeProvider = new NocoBaseEcoNarrativeProvider(),
    private validator = new NarrativeGroundingValidator(),
  ) {}

  async generateBrief(params: GenerateDailyOperationsBriefParams = {}) {
    const evidenceResult = await new EcobaseDailyOperationsBriefService(this.db).generateEvidence(params);
    const evidencePack = evidenceResult.evidencePack as DailyEvidencePack;
    if (params.mode === 'workflow_send' && !asString(params.recipient)) {
      const prompt = this.buildPrompt({ evidencePack, aiEmployeeUsername: asString(params.aiEmployeeUsername) ?? 'eco' });
      return this.persistBlocked({
        reportRunId: evidenceResult.reportRunId,
        status: 'blocked_delivery_configuration',
        validationStatus: 'failed',
        validationErrors: ['Ecobase daily operations brief delivery failed: workflow_send mode requires a recipient.'],
        prompt,
        rawResponse: '',
        llmService: asString(params.llmService) ?? 'codex-subscription-live',
        model: asString(params.model) ?? 'gpt-5.5',
        evidenceHash: stableHash(evidencePack),
      });
    }
    const llmService = asString(params.llmService) ?? 'codex-subscription-live';
    const model = asString(params.model) ?? 'gpt-5.5';
    const prompt = this.buildPrompt({ evidencePack, aiEmployeeUsername: asString(params.aiEmployeeUsername) ?? 'eco' });
    const maxBodyCharacters = Math.min(Math.max(Math.floor(params.maxBodyCharacters ?? 8000), 500), 20000);

    let rawResponse = '';
    let parsed: EcoNarrativeResponse | { error: string };
    let usedRepair = false;
    try {
      rawResponse = await this.provider.generate({ systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, llmService, model });
      parsed = parseNarrativeJson(rawResponse);
      if ('error' in parsed) {
        usedRepair = true;
        const repairPrompt = this.buildRepairPrompt(rawResponse, parsed.error, prompt.userPrompt);
        rawResponse = await this.provider.generate({ systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, repairPrompt, llmService, model });
        parsed = parseNarrativeJson(rawResponse);
      }
    } catch (error) {
      return this.persistBlocked({
        reportRunId: evidenceResult.reportRunId,
        status: 'blocked_ai_provider_unavailable',
        validationStatus: 'failed',
        validationErrors: [error instanceof Error ? error.message : 'AI provider failed.'],
        prompt,
        rawResponse,
        llmService,
        model,
        evidenceHash: stableHash(evidencePack),
      });
    }

    if ('error' in parsed) {
      return this.persistBlocked({
        reportRunId: evidenceResult.reportRunId,
        status: 'blocked_ai_response_invalid',
        validationStatus: 'failed',
        validationErrors: [parsed.error],
        prompt,
        rawResponse,
        llmService,
        model,
        evidenceHash: stableHash(evidencePack),
      });
    }

    const validation = this.validator.validate(evidencePack, parsed, maxBodyCharacters);
    const bodyText = markdownToText(parsed.bodyMarkdown);
    const bodyHtml = markdownToHtml(parsed.bodyMarkdown);
    const status: DailyBriefNarrativeStatus = validation.validationStatus === 'passed' ? 'ready_to_send' : 'blocked_ai_validation_failed';
    await this.updateReportRun({
      reportRunId: evidenceResult.reportRunId,
      status,
      validationStatus: validation.validationStatus,
      validationErrors: validation.validationErrors,
      prompt,
      rawResponse,
      normalizedResponse: parsed,
      llmService,
      model,
      bodyText,
      bodyHtml,
      evidenceHash: stableHash(evidencePack),
    });
    return {
      reportRunId: evidenceResult.reportRunId,
      status,
      validationStatus: validation.validationStatus,
      validationErrors: validation.validationErrors,
      focus: evidenceResult.focus,
      subject: parsed.subject,
      bodyMarkdown: parsed.bodyMarkdown,
      bodyHtml,
      bodyText,
      recipient: asString(params.recipient),
      warnings: evidenceResult.warnings,
      usedRepair,
    };
  }

  private buildPrompt(params: { evidencePack: DailyEvidencePack; aiEmployeeUsername: string }) {
    const evidencePack = sanitizeForPrompt(params.evidencePack);
    const systemPrompt = [
      `You are ${params.aiEmployeeUsername}, the Ecobase operations analyst.`,
      'Write one daily operations email for the team.',
      'Use ONLY the provided evidence pack.',
      'Do not invent ASINs, SKUs, quantities, suppliers, orders, dates, profit numbers, or statuses.',
      'If data is stale/missing, include the warning.',
      'Prioritize what needs team action today.',
      'Be concise but include enough evidence for action.',
      'Return valid JSON only.',
    ].join('\n');
    const userPrompt = JSON.stringify({
      instruction: 'Return JSON with subject, bodyMarkdown, citedEvidenceIds, dataWarningsMentioned, and confidence.',
      requiredShape: {
        subject: 'string',
        bodyMarkdown: 'string',
        citedEvidenceIds: ['string'],
        dataWarningsMentioned: ['string'],
        confidence: 'high|medium|low',
      },
      defaultBodyStructure: bodyStructureForFocus(evidencePack.focus),
      evidencePack,
    });
    return { systemPrompt, userPrompt };
  }

  private buildRepairPrompt(rawResponse: string, error: string, originalUserPrompt: string) {
    return JSON.stringify({
      instruction: 'Repair the prior response into valid JSON only. Preserve supported facts. Do not add new facts.',
      parseError: error,
      priorResponse: rawResponse.slice(0, 12000),
      originalRequest: JSON.parse(originalUserPrompt),
    });
  }

  private async persistBlocked(params: {
    reportRunId: string;
    status: DailyBriefNarrativeStatus;
    validationStatus: DailyBriefValidationStatus;
    validationErrors: string[];
    prompt: { systemPrompt: string; userPrompt: string };
    rawResponse: string;
    llmService: string;
    model: string;
    evidenceHash: string;
  }) {
    await this.updateReportRun({ ...params, normalizedResponse: undefined, bodyText: undefined, bodyHtml: undefined });
    return {
      reportRunId: params.reportRunId,
      status: params.status,
      validationStatus: params.validationStatus,
      validationErrors: params.validationErrors,
    };
  }

  private async updateReportRun(params: {
    reportRunId: string;
    status: DailyBriefNarrativeStatus;
    validationStatus: DailyBriefValidationStatus;
    validationErrors: string[];
    prompt: { systemPrompt: string; userPrompt: string };
    rawResponse: string;
    normalizedResponse?: EcoNarrativeResponse;
    llmService: string;
    model: string;
    bodyText?: string;
    bodyHtml?: string;
    evidenceHash: string;
  }) {
    await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).update({
      filterByTk: params.reportRunId,
      values: {
        status: params.status,
        validationStatus: params.validationStatus,
        deliveryStatus: params.status === 'ready_to_send' ? 'preview_ready' : 'blocked',
        emailStatus: params.status === 'ready_to_send' ? 'preview_ready' : 'blocked',
        evidenceHash: params.evidenceHash,
        subject: params.normalizedResponse?.subject,
        bodyMarkdown: params.normalizedResponse?.bodyMarkdown,
        bodyHtml: params.bodyHtml,
        bodyText: params.bodyText,
        aiPrompt: params.prompt,
        aiRawResponse: params.rawResponse,
        aiResponse: params.normalizedResponse ?? {},
        aiMetadata: { llmService: params.llmService, model: params.model },
        validationErrors: params.validationErrors,
      },
    });
    return toPlainRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).findOne({ filterByTk: params.reportRunId }));
  }
}
