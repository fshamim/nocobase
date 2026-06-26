import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import {
  EcobaseDailyOperationsBriefService,
  type DailyEvidencePack,
  type GenerateDailyOperationsBriefEvidenceParams,
} from './daily-operations-brief-service';
import {
  EcobaseDailyManagementSnapshotService,
  type DailyManagementSnapshotTrend,
} from './daily-management-snapshot-service';
import {
  EcobaseDailyBriefPromptSettingsService,
  type DailyBriefPromptSettings,
} from './daily-brief-prompt-settings-service';

type PlainRecord = Record<string, unknown>;
type DailyBriefNarrativeStatus =
  | 'ready_to_send'
  | 'blocked_delivery_configuration'
  | 'blocked_ai_provider_unavailable'
  | 'blocked_ai_response_invalid'
  | 'blocked_ai_validation_failed';
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
    getLLMService?: (options: { llmService: string; model: string }) => Promise<{
      provider?: {
        invoke?: (
          context: { messages: Array<{ role: 'system' | 'user'; content: string }> },
          options?: unknown,
        ) => Promise<unknown>;
      };
    }>;
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
  const common = [
    '# Ecobase Daily Operations Brief',
    '## Director action points',
    '## 3-minute summary',
    '## Inventory planning',
    '## Order planning',
    '## Tasks / owners',
    '## Future signals',
    '## Data warnings',
    'Bottom line',
  ];
  if (focus === 'source_quality')
    return [
      '# Ecobase Daily Operations Brief',
      '## Director action points',
      '## Data-confidence warning',
      '## Safe actions today',
      '## Inventory planning',
      '## Order planning',
      '## Tasks / owners',
      'Bottom line',
    ];
  return common;
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
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part)) return asString(part.text) ?? asString(part.content) ?? '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return asString(value.text) ?? asString(value.output_text) ?? '';
}

function parseNarrativeJson(raw: string): EcoNarrativeResponse | { error: string } {
  try {
    const trimmed = raw
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) return { error: 'Eco response JSON root must be an object.' };
    const subject = asString(parsed.subject);
    const bodyMarkdown = asString(parsed.bodyMarkdown);
    const citedEvidenceIds = Array.isArray(parsed.citedEvidenceIds)
      ? parsed.citedEvidenceIds.map(asString).filter((item): item is string => Boolean(item))
      : [];
    const dataWarningsMentioned = Array.isArray(parsed.dataWarningsMentioned)
      ? parsed.dataWarningsMentioned.map(asString).filter((item): item is string => Boolean(item))
      : [];
    const confidence =
      parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
        ? parsed.confidence
        : 'low';
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

function chipStyle(tone: 'danger' | 'warning' | 'success' | 'info' | 'default') {
  const tones = {
    danger: ['#fff1f0', '#ff4d4f', '#a8071a'],
    warning: ['#fff7e6', '#fa8c16', '#ad4e00'],
    success: ['#f6ffed', '#52c41a', '#237804'],
    info: ['#e6f4ff', '#1677ff', '#0958d9'],
    default: ['#f5f5f5', '#d9d9d9', '#595959'],
  }[tone];
  return `display:inline-flex;align-items:center;border-radius:999px;border:1px solid ${tones[1]};background:${tones[0]};color:${tones[2]};font-weight:600;font-size:12px;line-height:18px;padding:0 8px;margin:0 2px;white-space:nowrap;`;
}

function renderInlineMarkdown(text: string) {
  return escapeHtml(text)
    .replace(
      /`([^`]+)`/g,
      `<code style="background:#f5f5f5;border:1px solid #d9d9d9;border-radius:4px;padding:1px 5px;color:#0958d9;">$1</code>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;color:#141414;">$1</strong>')
    .replace(/\b(overdue|blocked|critical|not safe coverage)\b/gi, `<span style="${chipStyle('danger')}">$1</span>`)
    .replace(
      /\b(approval pending|supplier contacted|fallback|stale|warning|warnings)\b/gi,
      `<span style="${chipStyle('warning')}">$1</span>`,
    )
    .replace(/\b(purchased|inbound|trusted coverage|trusted)\b/gi, `<span style="${chipStyle('success')}">$1</span>`)
    .replace(/\b(OOS|today|director action points)\b/gi, `<span style="${chipStyle('info')}">$1</span>`)
    .replace(/\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g, `<strong style="color:#cf1322;font-weight:700;">$$$1</strong>`)
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, `<span style="${chipStyle('default')}">$1</span>`);
}

function renderBriefBlocks(lines: string[], tone: 'primary' | 'warning' | 'default') {
  const parts: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];
  const flushList = () => {
    if (listItems.length > 0) {
      parts.push(
        `<ul style="display:grid;gap:8px;margin:0;padding:0;list-style:none;">${listItems
          .map(
            (item) =>
              `<li style="display:flex;gap:10px;padding:10px 12px;border:1px solid #f0f0f0;border-left:4px solid ${
                tone === 'primary' ? '#1677ff' : tone === 'warning' ? '#faad14' : '#d9d9d9'
              };border-radius:8px;background:#fff;"><span style="width:8px;height:8px;margin-top:7px;border-radius:999px;background:${
                tone === 'primary' ? '#1677ff' : tone === 'warning' ? '#faad14' : '#8c8c8c'
              };flex:0 0 auto;"></span><span>${item}</span></li>`,
          )
          .join('')}</ul>`,
      );
      listItems = [];
    }
    if (orderedItems.length > 0) {
      parts.push(
        `<ol style="display:grid;gap:8px;margin:0;padding-left:22px;">${orderedItems
          .map((item) => `<li style="padding:8px 10px;border-radius:8px;background:#fafafa;">${item}</li>`)
          .join('')}</ol>`,
      );
      orderedItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) {
      if (orderedItems.length > 0) flushList();
      listItems.push(renderInlineMarkdown(bullet[1]));
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listItems.length > 0) flushList();
      orderedItems.push(renderInlineMarkdown(ordered[1]));
      continue;
    }
    flushList();
    if (/^bottom line:?/i.test(line)) {
      parts.push(
        `<div style="border:1px solid #91caff;background:#e6f4ff;border-radius:10px;padding:12px 14px;color:#0958d9;font-weight:600;">${renderInlineMarkdown(
          line,
        )}</div>`,
      );
    } else if (line.endsWith(':')) {
      parts.push(`<div style="font-weight:700;color:#262626;margin-top:4px;">${renderInlineMarkdown(line)}</div>`);
    } else {
      parts.push(`<p style="margin:0;color:#262626;line-height:1.65;">${renderInlineMarkdown(line)}</p>`);
    }
  }
  flushList();
  return parts.join('\n');
}

function sectionTone(title: string): 'primary' | 'warning' | 'default' {
  const lower = title.toLowerCase();
  if (lower.includes('director') || lower.includes('safe actions')) return 'primary';
  if (lower.includes('warning') || lower.includes('data-confidence')) return 'warning';
  return 'default';
}

function markdownToHtml(markdown: string, reportDate?: string) {
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | undefined;
  for (const rawLine of markdown.split('\n')) {
    const heading = rawLine.match(/^##\s+(.+)$/);
    if (heading) {
      current = { title: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (rawLine.startsWith('# ')) continue;
    if (!current) {
      current = { title: 'Action brief', lines: [] };
      sections.push(current);
    }
    current.lines.push(rawLine);
  }

  const dateBadge = reportDate
    ? `<div style="display:flex;justify-content:flex-end;"><span style="${chipStyle('info')}">Report date: ${escapeHtml(
        reportDate,
      )}</span></div>`
    : '';
  return `<div style="display:grid;gap:14px;font-family:inherit;">${dateBadge}${sections
    .filter((section) => section.lines.some((line) => line.trim()))
    .map((section) => {
      const tone = sectionTone(section.title);
      const border = tone === 'primary' ? '#91caff' : tone === 'warning' ? '#ffd591' : '#f0f0f0';
      const background = tone === 'primary' ? '#f0f7ff' : tone === 'warning' ? '#fff7e6' : '#ffffff';
      const color = tone === 'primary' ? '#0958d9' : tone === 'warning' ? '#ad4e00' : '#262626';
      return `<section style="border:1px solid ${border};border-radius:12px;background:${background};overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.03);"><div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid ${border};"><span style="${chipStyle(
        tone === 'warning' ? 'warning' : tone === 'primary' ? 'info' : 'default',
      )}">${escapeHtml(section.title)}</span></div><div style="display:grid;gap:10px;padding:14px;">${renderBriefBlocks(
        section.lines,
        tone,
      )}</div></section>`;
    })
    .join('')}</div>`;
}

function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function collectEvidenceIds(pack: DailyEvidencePack) {
  return new Set([
    ...list(pack.sourceStatus).map((item) => item.evidenceId),
    ...list(pack.inventoryRisks).map((item) => item.evidenceId),
    ...list(pack.supplierOrderContext).map((item) => item.evidenceId),
    ...list(pack.orderPlanningRisks).map((item) => item.evidenceId),
    ...list(pack.leadTimeIssues).map((item) => item.evidenceId),
    ...list(pack.performanceTrends).map((item) => item.evidenceId),
    ...list(pack.buyBoxRisks).map((item) => item.evidenceId),
    ...list(pack.okrAccountabilityRisks).map((item) => item.evidenceId),
    ...list(pack.dataWarnings).map((item) => item.evidenceId),
  ]);
}

function moneyKeys(value: unknown) {
  const number = typeof value === 'string' ? Number(value.replace(/[$,%\s,]/g, '')) : asNumber(value);
  if (number === undefined || !Number.isFinite(number)) return [];
  return [String(Math.round(number)), number.toFixed(2)];
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
    for (const key of moneyKeys(value)) moneyValues.add(key);
  };
  const addText = (value: unknown) => {
    const text = asString(value);
    if (!text) return;
    for (const date of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) dates.add(date[0]);
    for (const money of text.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)) addMoney(money[1]);
    for (const orderRef of tokens(text, /\b(?:PO|RH)(?=[A-Z0-9-]*\d)[A-Z0-9-]{2,}\b/gi)) orders.add(orderRef);
  };
  for (const risk of list(pack.inventoryRisks)) {
    if (risk.asin) asins.add(risk.asin.toUpperCase());
    if (risk.sku) skus.add(risk.sku.toUpperCase());
    if (risk.supplierOrderRef) orders.add(risk.supplierOrderRef.toUpperCase());
    addDate(risk.estimatedOosDate);
    addDate(risk.latestSafeReorderDate);
    addMoney(risk.estimatedProfitRisk);
  }
  for (const order of list(pack.supplierOrderContext)) {
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
  for (const order of list(pack.orderPlanningRisks)) {
    if (order.orderRef) orders.add(order.orderRef.toUpperCase());
    if (order.orderId) orders.add(order.orderId.toUpperCase());
    addDate(order.nextActionDueAt);
    addDate(order.expectedDeliveryDate);
    addDate(order.earliestOosDate);
    addMoney(order.moneyAtRisk);
  }
  for (const trend of list(pack.performanceTrends)) {
    if (trend.asin) asins.add(trend.asin.toUpperCase());
    if (trend.sku) skus.add(trend.sku.toUpperCase());
    addDate(trend.currentDate);
    addDate(trend.baselineDate);
    addMoney(trend.estimatedProfitImpact);
    addMoney(trend.profitGap);
  }
  for (const risk of list(pack.buyBoxRisks)) {
    if (risk.asin) asins.add(risk.asin.toUpperCase());
    if (risk.sku) skus.add(risk.sku.toUpperCase());
    addDate(risk.currentDate);
    addDate(risk.baselineDate);
  }
  for (const leadTime of list(pack.leadTimeIssues)) {
    if (leadTime.asin) asins.add(leadTime.asin.toUpperCase());
    if (leadTime.sku) skus.add(leadTime.sku.toUpperCase());
    addDate(leadTime.leadTimeConfirmedAt);
  }
  for (const item of list(pack.okrAccountabilityRisks)) {
    addDate(item.dueDate);
    addDate(item.lastMeaningfulUpdateAt);
  }
  for (const warning of list(pack.dataWarnings)) {
    if (warning.asin) asins.add(warning.asin.toUpperCase());
    if (warning.sku) skus.add(warning.sku.toUpperCase());
    addText(warning.message);
    addText(JSON.stringify(warning.metadata ?? {}));
  }
  for (const source of list(pack.sourceStatus)) {
    addText(source.connectionName);
    addText(source.sourceType);
    addText(JSON.stringify(source));
  }
  if (isRecord(pack.managementKpiTrends)) {
    addDate(pack.managementKpiTrends.date);
    const currentSnapshot = isRecord(pack.managementKpiTrends.currentSnapshot)
      ? pack.managementKpiTrends.currentSnapshot
      : undefined;
    const baselineSnapshot = isRecord(pack.managementKpiTrends.baselineSnapshot)
      ? pack.managementKpiTrends.baselineSnapshot
      : undefined;
    for (const snapshot of [currentSnapshot, baselineSnapshot]) {
      if (!snapshot) continue;
      addDate(snapshot.snapshotDate);
      for (const value of Object.values(snapshot)) addMoney(value);
    }
    const kpis = Array.isArray(pack.managementKpiTrends.kpis) ? pack.managementKpiTrends.kpis : [];
    for (const kpi of kpis) {
      if (!isRecord(kpi)) continue;
      addMoney(kpi.value);
      addMoney(kpi.previousValue);
      addMoney(kpi.absoluteDelta);
    }
    const trendWarnings = Array.isArray(pack.managementKpiTrends.warnings) ? pack.managementKpiTrends.warnings : [];
    trendWarnings.forEach(addText);
  }
  pack.omissions.forEach(addText);
  pack.assumptions.forEach(addText);
  return { asins, skus, orders, dates, moneyValues };
}

function tokens(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].map((match) => match[0].toUpperCase());
}

export class NocoBaseEcoNarrativeProvider implements EcoNarrativeProvider {
  constructor(private app?: AppLike) {}

  async generate(input: EcoNarrativeProviderInput) {
    const plugin = this.app?.pm?.get?.('ai') as AiPluginLike | undefined;
    const service = await plugin?.aiManager?.getLLMService?.({ llmService: input.llmService, model: input.model });
    if (!service?.provider?.invoke) {
      throw new Error(
        `Ecobase daily operations brief failed: AI provider ${input.llmService}/${input.model} is unavailable.`,
      );
    }
    return extractTextFromAiResponse(
      await service.provider.invoke({
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.repairPrompt ?? input.userPrompt },
        ],
      }),
    );
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
    if (response.bodyMarkdown.length > maxBodyCharacters)
      errors.push(`Narrative bodyMarkdown exceeds ${maxBodyCharacters} characters.`);

    for (const id of response.citedEvidenceIds) {
      if (!evidenceIds.has(id)) errors.push(`Narrative cited unsupported evidence id ${id}.`);
    }
    for (const asin of tokens(narrative, /\bB0[A-Z0-9]{6,8}\b/gi)) {
      if (!known.asins.has(asin)) errors.push(`Narrative referenced unsupported ASIN ${asin}.`);
    }
    for (const orderRef of tokens(narrative, /\b(?:PO|RH)(?=[A-Z0-9-]*\d)[A-Z0-9-]{2,}\b/gi)) {
      if (!known.orders.has(orderRef)) errors.push(`Narrative referenced unsupported supplier order ${orderRef}.`);
    }
    for (const date of [...narrative.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0])) {
      if (!known.dates.has(date)) errors.push(`Narrative referenced unsupported date ${date}.`);
    }
    for (const money of [...narrative.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)].map((match) => match[1])) {
      const keys = moneyKeys(money);
      if (!keys.some((key) => known.moneyValues.has(key))) {
        errors.push(`Narrative referenced unsupported dollar value $${money}.`);
      }
    }
    const warningCount = pack.dataWarnings.filter((item) => item.severity === 'warning').length;
    if (warningCount > 0 && !/data warnings?|stale|missing|fallback|incomplete|source/i.test(narrative)) {
      errors.push('Narrative omitted data-warning section.');
    }
    if (/secret:\/\/|bearer\s+[a-z0-9._-]+|token=|api[_-]?key/i.test(narrative)) {
      errors.push('Narrative contains credential-like text.');
    }
    return {
      validationStatus: errors.length
        ? ('failed' as DailyBriefValidationStatus)
        : ('passed' as DailyBriefValidationStatus),
      validationErrors: errors,
    };
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
    const rawEvidencePack = evidenceResult.evidencePack as DailyEvidencePack;
    const evidencePack = {
      ...rawEvidencePack,
      date: asString(rawEvidencePack.date) ?? asString(params.date) ?? new Date().toISOString().slice(0, 10),
    };
    const companyName = asString(evidencePack.company?.name) ?? asString(params.company);
    const promptSettingsResult = await new EcobaseDailyBriefPromptSettingsService(this.db).getActiveSettings(companyName);
    const managementKpiTrends = await new EcobaseDailyManagementSnapshotService(this.db).getTrend({
      date: evidencePack.date,
      company: companyName,
      period: '7d',
    });
    const evidencePackForPrompt: DailyEvidencePack = { ...evidencePack, managementKpiTrends };
    if (params.mode === 'workflow_send' && !asString(params.recipient)) {
      const prompt = this.buildPrompt({
        evidencePack: evidencePackForPrompt,
        aiEmployeeUsername: asString(params.aiEmployeeUsername) ?? 'eco',
        promptSettings: promptSettingsResult.settings,
        promptSettingsWarning: promptSettingsResult.warning,
      });
      return this.persistBlocked({
        reportRunId: evidenceResult.reportRunId,
        status: 'blocked_delivery_configuration',
        validationStatus: 'failed',
        validationErrors: ['Ecobase daily operations brief delivery failed: workflow_send mode requires a recipient.'],
        prompt,
        rawResponse: '',
        llmService: asString(params.llmService) ?? promptSettingsResult.settings.llmService ?? 'codex-subscription-live',
        model: asString(params.model) ?? promptSettingsResult.settings.model ?? 'gpt-5.5',
        evidenceHash: stableHash(evidencePack),
        promptSettings: promptSettingsResult.settings,
        promptSettingsWarning: promptSettingsResult.warning,
      });
    }
    if (params.forceRegenerate !== true && params.mode !== 'workflow_send') {
      const existingRun = toPlainRecord(
        await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).findOne({ filterByTk: evidenceResult.reportRunId }),
      );
      const bodyMarkdown = asString(existingRun.bodyMarkdown);
      const subject = asString(existingRun.subject) ?? 'Ecobase daily operations brief';
      if (bodyMarkdown && asString(existingRun.status) === 'ready_to_send') {
        const bodyHtml = markdownToHtml(bodyMarkdown, evidencePack.date);
        const bodyText = markdownToText(bodyMarkdown);
        if (asString(existingRun.bodyHtml) !== bodyHtml || asString(existingRun.bodyText) !== bodyText) {
          await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).update({
            filterByTk: evidenceResult.reportRunId,
            values: { bodyHtml, bodyText },
          });
        }
        return {
          reportRunId: evidenceResult.reportRunId,
          status: 'ready_to_send' as DailyBriefNarrativeStatus,
          validationStatus: (asString(existingRun.validationStatus) ?? 'passed') as DailyBriefValidationStatus,
          validationErrors: Array.isArray(existingRun.validationErrors) ? existingRun.validationErrors : [],
          focus: evidenceResult.focus,
          subject,
          bodyMarkdown,
          bodyHtml,
          bodyText,
          recipient: asString(params.recipient),
          warnings: evidenceResult.warnings,
          usedRepair: false,
        };
      }
    }

    const llmService = asString(params.llmService) ?? promptSettingsResult.settings.llmService ?? 'codex-subscription-live';
    const model = asString(params.model) ?? promptSettingsResult.settings.model ?? 'gpt-5.5';
    const prompt = this.buildPrompt({
      evidencePack: evidencePackForPrompt,
      aiEmployeeUsername: asString(params.aiEmployeeUsername) ?? 'eco',
      promptSettings: promptSettingsResult.settings,
      promptSettingsWarning: promptSettingsResult.warning,
    });
    const maxBodyCharacters = Math.min(Math.max(Math.floor(params.maxBodyCharacters ?? 8000), 500), 20000);

    let rawResponse = '';
    let parsed: EcoNarrativeResponse | { error: string };
    let usedRepair = false;
    try {
      rawResponse = await this.provider.generate({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        llmService,
        model,
      });
      parsed = parseNarrativeJson(rawResponse);
      if ('error' in parsed) {
        usedRepair = true;
        const repairPrompt = this.buildRepairPrompt(rawResponse, parsed.error, prompt.userPrompt);
        rawResponse = await this.provider.generate({
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          repairPrompt,
          llmService,
          model,
        });
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

    const validation = this.validator.validate(evidencePackForPrompt, parsed, maxBodyCharacters);
    const bodyText = markdownToText(parsed.bodyMarkdown);
    const bodyHtml = markdownToHtml(parsed.bodyMarkdown, evidencePack.date);
    const status: DailyBriefNarrativeStatus =
      validation.validationStatus === 'passed' ? 'ready_to_send' : 'blocked_ai_validation_failed';
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
      promptSettings: promptSettingsResult.settings,
      promptSettingsWarning: promptSettingsResult.warning,
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

  private buildPrompt(params: {
    evidencePack: DailyEvidencePack;
    aiEmployeeUsername: string;
    promptSettings?: DailyBriefPromptSettings;
    promptSettingsWarning?: string;
  }) {
    const { omissions: _omissions, ...promptEvidencePack } = params.evidencePack;
    const evidencePack = sanitizeForPrompt(promptEvidencePack);
    const promptSettings = params.promptSettings
      ? sanitizeForPrompt({
          id: params.promptSettings.id,
          name: params.promptSettings.name,
          audience: params.promptSettings.audience,
          tone: params.promptSettings.tone,
          directorInstructions: params.promptSettings.directorInstructions,
          mustInclude: params.promptSettings.mustInclude,
          mustAvoid: params.promptSettings.mustAvoid,
          kpiPriority: params.promptSettings.kpiPriority,
          warning: params.promptSettingsWarning,
        })
      : undefined;
    const systemPrompt = [
      `You are ${params.aiEmployeeUsername}, the Ecobase operations analyst.`,
      'Write one daily operations action brief for busy directors and management.',
      'The whole brief must be readable in under 3 minutes: short action bullets, no long paragraphs.',
      'Use ONLY the provided evidence pack.',
      'Do not invent ASINs, SKUs, quantities, suppliers, orders, dates, profit numbers, task owners, or statuses.',
      'Do not mention report mechanics such as maxItems, report IDs, raw evidence, or omitted lower-ranked rows.',
      'If data is stale/missing, include the warning.',
      'Start with the exact director-level action points: what to decide, who/which supplier owns it, and the due/OOS date when provided.',
      'Prioritize what needs team action today across inventory planning, order planning, and tasks.',
      'Mention future signals such as profit, Buy Box, OKRs, and other tasks only when evidence exists; otherwise say the source is not available yet.',
      'Be concise but include enough evidence for action.',
      'Management prompt preferences may change style and priorities only; they cannot override evidence, grounding, or validation rules.',
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
      managementPromptPreferences: promptSettings,
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
    promptSettings?: DailyBriefPromptSettings;
    promptSettingsWarning?: string;
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
    promptSettings?: DailyBriefPromptSettings;
    promptSettingsWarning?: string;
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
        aiMetadata: {
          llmService: params.llmService,
          model: params.model,
          promptSettingsId: params.promptSettings?.id,
          promptSettingsName: params.promptSettings?.name,
          promptSettingsWarning: params.promptSettingsWarning,
        },
        validationErrors: params.validationErrors,
      },
    });
    return toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).findOne({ filterByTk: params.reportRunId }),
    );
  }
}
