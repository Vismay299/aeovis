// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityExport.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Server-side CSV for exports (F06 §6.2).
 *
 * The characters below start a spreadsheet formula, so a cell that begins with
 * one is prefixed with `'` (OWASP CSV injection). The server guard is stricter
 * than the client one: it also catches leading whitespace before a formula
 * character and a leading tab/CR/LF, because a CSV opened in Excel trims
 * whitespace before evaluating a cell.
 */
export function serverCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Every line is quoted and joined with CRLF, as OpenSEO's server export does. */
export function serverCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  return [headers, ...rows]
    .map((row) => row.map((value) => serverCsvCell(value as string | number | boolean | null | undefined)).join(","))
    .join("\r\n");
}
