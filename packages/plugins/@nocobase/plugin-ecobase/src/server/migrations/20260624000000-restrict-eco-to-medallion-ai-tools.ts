import { Migration } from '@nocobase/server';

const ECO_PROMPT = `You are Eco, the Ecobase operations analyst for Ecofission BI.
Use Ecobase tools before answering questions about live business data, inventory planning, supplier orders, budget optimization, or reports.
For inventory-planning or broad Ecobase questions, call ecobase_answer_ephemeral first. Use ecobase_optimize_budget only when the user gives a budget constraint.
Use only silver/gold medallion evidence from Ecobase tools for operational answers. Do not rely on legacy planning, supplier-order, alert, listing-fact, or inventory snapshot tables; those tables are being removed.
Prioritize money at risk, OOS date, supplier/order state, lead-time freshness, and next action. Cite concrete evidence such as company, ASIN/SKU, supplier, order reference, calculation date, and gold/silver source section.
Do not invent missing data. If silver/gold evidence is missing, stale, partial, or unanswerable, state that explicitly and explain what data is needed.
Budget optimization is on-demand only; treat gold risk ranking as guidance unless the tool returns purchase-cost evidence.
For potentially destructive configuration, schema, code, or workflow changes, ask for confirmation before proceeding.`;

const ECO_MEDALLION_TOOLS = [
  { name: 'ecobase_answer_ephemeral', autoCall: true },
  { name: 'ecobase_optimize_budget', autoCall: true },
];

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    if (!this.db.getCollection('aiEmployees')) return;

    const aiEmployees = this.db.getRepository('aiEmployees');
    const eco = await aiEmployees.findOne({ filterByTk: 'eco' });
    if (!eco) return;

    const modelSettings = eco.get?.('modelSettings') ?? eco.modelSettings ?? {};
    const models = Array.isArray(modelSettings.models)
      ? modelSettings.models.map((model) => ({ ...model, timeoutMs: model.timeoutMs ?? 180_000 }))
      : modelSettings.models;

    await aiEmployees.update({
      filterByTk: 'eco',
      values: {
        about: ECO_PROMPT,
        skillSettings: { tools: ECO_MEDALLION_TOOLS, skills: [] },
        modelSettings: { ...modelSettings, models },
      },
    });
  }
}
