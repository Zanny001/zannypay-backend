// Deliberately not a dependency (e.g. `json2csv`) for something this
// small — RFC 4180 escaping is three rules: wrap in quotes if the field
// contains a comma, a quote, or a newline; double up any internal quotes.
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(columns: { key: string; header: string }[], rows: Record<string, unknown>[]): string {
  const headerLine = columns.map((c) => escapeCsvField(c.header)).join(',');
  const dataLines = rows.map((row) => columns.map((c) => escapeCsvField(row[c.key])).join(','));
  return [headerLine, ...dataLines].join('\r\n');
}
