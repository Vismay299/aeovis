// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/telemetry.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type AuditServerTracker = (
  name: string,
  props: Record<string, unknown>,
) => void | Promise<void>;

let tracker: AuditServerTracker | null = null;

/**
 * Configure a custom server event tracker (useful for testing or hooking into telemetry sinks).
 */
export function setAuditServerTracker(fn: AuditServerTracker | null): void {
  tracker = fn;
}

/**
 * Captures a site audit server event.
 * Dispatches to custom tracker if set, or attempts dynamic import of F26 server sink, or no-ops.
 */
export async function captureAuditEvent(
  name: string,
  props: Record<string, unknown>,
): Promise<void> {
  if (tracker) {
    try {
      await tracker(name, props);
    } catch {
      // no-op
    }
    return;
  }

  try {
    const { captureServerEvent } = await import("../../shared/telemetry/server.ts");
    await (captureServerEvent as any)({ name, props });
  } catch {
    // no-op if telemetry sink is not yet wired or unavailable
  }
}
