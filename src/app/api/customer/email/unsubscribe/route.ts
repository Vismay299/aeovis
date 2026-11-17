import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { readEmailConfig, type EmailConfig } from "../../../../../server/email/config.ts";
import { savePreferences } from "../../../../../server/email/preferences.ts";
import { verifyUnsubscribe, appLink } from "../../../../../server/email/links.ts";
import { trackEmailEvent } from "../../../../../server/email/telemetry.ts";
import { updateLoopsContact, type LoopsDeps } from "../../../../../shared/providers/loops/client.ts";
import { emailUnsubscribeRequest } from "../../../../../server/email/email.contract.ts";

export const dynamic = "force-dynamic";

export type UnsubscribeRouteDeps = {
  getSupabaseAdmin?: () => SupabaseClient | null;
  config?: EmailConfig;
  loops?: LoopsDeps;
};

const COLUMN_FOR_CATEGORY = {
  scan_results: "scan_results",
  schedule_alerts: "schedule_alerts",
  spend_alerts: "spend_alerts",
  product_updates: "product_updates",
} as const;

function redirect(to: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: to, "cache-control": "no-store" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function adminOrUnavailable(deps?: UnsubscribeRouteDeps): Promise<SupabaseClient> {
  // Production passes no deps: fall back to the real service-role client, the
  // same way requireUser does. Tests inject a fake.
  let admin: SupabaseClient | null;
  if (deps?.getSupabaseAdmin) {
    admin = deps.getSupabaseAdmin();
  } else {
    const mod = await import("../../../../../shared/supabase/admin.js");
    admin = mod.getSupabaseAdmin() as SupabaseClient | null;
  }
  if (!admin) {
    throw new AppError(
      503,
      "preferences_unavailable",
      "Email settings are unavailable right now. Please retry.",
    );
  }
  return admin;
}

async function readTokenBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }
  }
  try {
    const form = await request.formData();
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    throw new AppError(400, "invalid_request", "The request body could not be read.");
  }
}

export async function POST(request: Request, _ctx?: unknown, deps?: UnsubscribeRouteDeps): Promise<Response> {
  try {
    const config = deps?.config ?? readEmailConfig();
    const raw = await readTokenBody(request);
    const parsed = emailUnsubscribeRequest.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "The request was not valid.",
      );
    }
    const { u, c, t } = parsed.data;

    if (!verifyUnsubscribe(config, u, c, t)) {
      throw new AppError(
        401,
        "invalid_link",
        "This link is not valid. Sign in to change your email settings.",
      );
    }

    const admin = await adminOrUnavailable(deps);
    const column = COLUMN_FOR_CATEGORY[c];
    let loopsSynced = true;

    if (c === "product_updates") {
      loopsSynced = false;
      if (config.apiKey && config.productUpdatesListId) {
        try {
          let email: string | null = null;
          try {
            const { data } = await admin.auth.admin.getUserById(u);
            email = data?.user?.email ?? null;
          } catch {
            email = null;
          }
          if (email) {
            await updateLoopsContact(
              {
                apiKey: config.apiKey,
                payload: {
                  email,
                  userId: u,
                  mailingLists: { [config.productUpdatesListId]: false },
                },
              },
              deps?.loops,
            );
            loopsSynced = true;
          }
        } catch {
          loopsSynced = false;
        }
      }
    }

    try {
      const patch: {
        product_updates?: boolean;
        scan_results?: boolean;
        schedule_alerts?: boolean;
        spend_alerts?: boolean;
      } = {};
      patch[column] = false;
      await savePreferences(admin, u, patch, "unsubscribe_link");
    } catch {
      throw new AppError(
        503,
        "preferences_unavailable",
        "Email settings are unavailable right now. Please retry.",
      );
    }

    trackEmailEvent("email:unsubscribed", { category: c });

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return json({ unsubscribed: true, category: c, loopsSynced });
    }
    const doneUrl =
      `${appLink(config, "/email/unsubscribe")}` +
      `?u=${encodeURIComponent(u)}&c=${encodeURIComponent(c)}&t=${encodeURIComponent(t)}&done=1`;
    return redirect(doneUrl);
  } catch (err) {
    return toErrorResponse(err);
  }
}
