import { getSupabaseAdmin } from "../../../../../shared/supabase/admin.js";
import { customerSessionBinding } from "../../../../../shared/supabase/sessionBinding.js";
import { handleGa4Callback } from "../../../../../server/ga4/oauth.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4CallbackRouteDeps = {
  getCustomerContext?: () => Promise<any>;
  getSupabaseAdmin?: () => any;
  customerSessionBinding?: typeof customerSessionBinding;
  handleGa4Callback?: typeof handleGa4Callback;
  fetchImpl?: typeof fetch;
};

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: Ga4CallbackRouteDeps,
): Promise<Response> {
  const getCtx =
    deps?.getCustomerContext ??
    (async () => {
      const { getCustomerContext } = await import("../../../../../shared/supabase/customer.js");
      return getCustomerContext();
    });
  const context = await getCtx();

  // 1. No session -> redirect to login
  if (!context?.user?.id) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login?next=/portal/settings/integrations",
      },
    });
  }

  const getAdmin = deps?.getSupabaseAdmin ?? (() => getSupabaseAdmin());
  const admin = getAdmin();

  const getSessionBinding = deps?.customerSessionBinding ?? customerSessionBinding;
  const sessionHash = (await getSessionBinding(context)) || "";

  const callbackHandler = deps?.handleGa4Callback ?? handleGa4Callback;
  const result = await callbackHandler({
    admin,
    url: new URL(request.url),
    userId: context.user.id,
    sessionTokenHash: sessionHash,
    fetchImpl: deps?.fetchImpl,
  });

  return new Response(null, {
    status: 303,
    headers: {
      Location: result.redirect,
    },
  });
}
