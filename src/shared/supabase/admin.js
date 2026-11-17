import { createClient } from "@supabase/supabase-js";

if (typeof window !== "undefined") {
  throw new Error("Supabase admin client is server-only.");
}

let cachedAdmin = null;

/** Server-only client for trusted admin operations. Never import into a client component. */
export function getSupabaseAdmin(env = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!cachedAdmin || cachedAdmin.url !== url || cachedAdmin.key !== key) {
    cachedAdmin = {
      url,
      key,
      client: createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    };
  }
  return cachedAdmin.client;
}
