export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
}

export interface CsvSourceFile {
  name: string;
  content: string;
  snapshotDate?: string;
  expectedRowCount?: number;
}

export function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function parseCsv(content: string): CsvParseResult {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  const [headers = [], ...dataRows] = records;
  const rows = dataRows
    .filter((values) => values.some((value) => value.trim().length > 0))
    .map((values) =>
      headers.reduce<Record<string, string>>((record, header, index) => {
        record[header] = values[index] ?? '';
        return record;
      }, {}),
    );

  return { headers, rows };
}

export class CsvRowReader {
  private normalizedHeaders: Map<string, string>;

  constructor(private row: Record<string, string>) {
    this.normalizedHeaders = new Map(
      Object.keys(row).map((header) => [normalizeHeader(header), header] as [string, string]),
    );
  }

  string(...headers: string[]) {
    for (const header of headers) {
      const sourceHeader = this.normalizedHeaders.get(normalizeHeader(header));
      if (!sourceHeader) {
        continue;
      }
      const value = this.row[sourceHeader]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  number(...headers: string[]) {
    const value = this.string(...headers);
    if (!value || value === '#N/A') {
      return undefined;
    }
    const normalized = value.replace(/[$,%]/g, '').replace(/,/g, '').trim();
    if (!normalized) {
      return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  payload() {
    return { ...this.row };
  }
}

export function normalizedHeaderSet(headers: string[]) {
  return new Set(headers.map(normalizeHeader));
}
