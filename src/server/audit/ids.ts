// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/ids.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";

/**
 * Generates an RFC 9562 UUIDv8 from stable content parts using SHA-256.
 * Format: xxxxxxxx-xxxx-8xxx-[89ab]xxx-xxxxxxxxxxxx
 */
export function deterministicUuid(...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("|")).digest();
  const bytes = new Uint8Array(hash.buffer, hash.byteOffset, 16);
  // Version 8: set high nibble of byte 6 to 0x8
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  // Variant 1: set high 2 bits of byte 8 to 0b10
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export const deterministicAuditRowId = deterministicUuid;
