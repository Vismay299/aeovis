import { createHash } from "node:crypto";

/** Supabase session_id is stable across refreshes and differs between logins. */
export async function customerSessionBinding(context) {
  if (!context.user || !context.client) return null;
  const { data, error } = await context.client.auth.getSession();
  if (error || !data?.session?.access_token) return null;
  try {
    const claims = JSON.parse(Buffer.from(data.session.access_token.split(".")[1], "base64url").toString());
    if (!claims.session_id || claims.sub !== context.user.id) return null;
    return createHash("sha256").update(`${context.user.id}:${claims.session_id}`).digest("hex");
  } catch { return null; }
}
