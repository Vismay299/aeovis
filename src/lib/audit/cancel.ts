// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/services/AuditService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Creates a cached probe for checking if an audit has requested cancellation.
 * Reads site_audits.cancel_requested_at.
 * Caches negative results for ttlMs; caches positive results permanently.
 */
export function createCancelProbe(
  admin: any,
  auditId: string,
  ttlMs = 5_000,
): () => Promise<boolean> {
  let isCancelled = false;
  let cacheUntil = 0;

  return async (): Promise<boolean> => {
    if (isCancelled) return true;
    const now = Date.now();
    if (now < cacheUntil) return false;

    cacheUntil = now + ttlMs;
    try {
      if (typeof admin?.getAudit === "function") {
        const audit = await admin.getAudit(auditId);
        if (audit?.cancel_requested_at) {
          isCancelled = true;
          return true;
        }
        return false;
      }
      if (typeof admin?.from === "function") {
        const { data, error } = await admin
          .from("site_audits")
          .select("cancel_requested_at")
          .eq("id", auditId)
          .maybeSingle();
        if (!error && data?.cancel_requested_at) {
          isCancelled = true;
          return true;
        }
      }
    } catch {
      // transient read errors do not flip cancel
    }
    return false;
  };
}
