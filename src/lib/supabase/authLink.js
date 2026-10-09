import { getSupabaseBrowserClient } from "./browser.js";

/** Admin invitations and recovery links may return an implicit token fragment.
 * Consume it explicitly with the PKCE browser client, clearing the URL first. */
export async function consumeCustomerAuthFragment({ client: injectedClient } = {}) {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  const linkError = params.get("error");
  if (!accessToken && !refreshToken && !linkError) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  if (linkError || !accessToken || !refreshToken) throw new Error("This account link is invalid or expired. Please request a new one.");
  const client = injectedClient ?? getSupabaseBrowserClient();
  if (!client) throw new Error("Customer login is not configured.");
  const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error) throw new Error("This account link is invalid or expired. Please request a new one.");
}
