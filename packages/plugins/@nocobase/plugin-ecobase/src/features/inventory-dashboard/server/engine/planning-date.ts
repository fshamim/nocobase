const DAY_MS = 86_400_000;

export function isoDate(value: string | Date, context = 'Ecobase planning date') {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error(`${context}: expected a valid date, got ${describeDateValue(value)}.`);
    }
    return value.toISOString().slice(0, 10);
  }
  const text = value.trim();
  const normalized = text.includes('T') ? text : `${text}T00:00:00.000Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${context}: expected a valid date, got ${describeDateValue(value)}.`);
  }
  return date.toISOString().slice(0, 10);
}

export function optionalIsoDate(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const normalized = text.includes('T') ? text : `${text}T00:00:00.000Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

export function addDays(date: string, days: number) {
  if (!Number.isFinite(days)) {
    throw new Error(`Ecobase planning date: days must be finite, got ${String(days)}.`);
  }
  const next = new Date(`${isoDate(date, 'Ecobase planning addDays date')}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + Math.floor(days));
  return isoDate(next, 'Ecobase planning addDays result');
}

export function diffDays(left: string, right: string) {
  const leftTime = new Date(`${isoDate(left, 'Ecobase planning diffDays left date')}T00:00:00.000Z`).getTime();
  const rightTime = new Date(`${isoDate(right, 'Ecobase planning diffDays right date')}T00:00:00.000Z`).getTime();
  return Math.round((leftTime - rightTime) / DAY_MS);
}

function describeDateValue(value: string | Date) {
  return value instanceof Date ? value.toString() : JSON.stringify(value);
}
