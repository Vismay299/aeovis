// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/html-response.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const MAX_HTML_BYTES = 1024 * 1024; // 1 MiB

export function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= maxBytes
    ? text
    : new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

export async function readTextUpTo(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Expected response bytes");
      }

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));

      if (bytesRead >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  parts.push(decoder.decode());
  return parts.join("");
}
