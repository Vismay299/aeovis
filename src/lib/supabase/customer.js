import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { resolveCustomerContext } from "./customerContext.js";

/** Create a request-scoped Supabase client whose JWT is protected by RLS. */
export async function createCustomerSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
      // Server components cannot write cookies. Customer data routes can
      // persist refreshed session cookies normally.
        }
      },
    },
  });
}

/** Resolve the authenticated user and only the brands assigned to that user. */
export async function getCustomerContext({ client: injectedClient } = {}) {
  const client = injectedClient ?? await createCustomerSupabaseClient();
  return resolveCustomerContext(client);
}

export { findCustomerBrand } from "./customerContext.js";
