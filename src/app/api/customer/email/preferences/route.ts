import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, type RequireUserDeps } from "../../../../../server/auth/requireUser.ts";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { readEmailConfig, type EmailConfig } from "../../../../../server/email/config.ts";
import {
  readPreferences,
  savePreferences,
  setProductUpdates,
  type UserEmailPreferences,
} from "../../../../../server/email/preferences.ts";
import { trackEmailEvent } from "../../../../../server/email/telemetry.ts";
import type { LoopsDeps } from "../../../../../shared/providers/loops/client.ts";
import {
  emailPreferencesPutRequest,
  emailPreferencesQuery,
} from "../../../../../server/email/email.contract.ts";

export const dynamic = "force-dynamic";

export type PreferencesRouteDeps = RequireUserDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  config?: EmailConfig;
  loops?: LoopsDeps;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function shape(prefs: UserEmailPreferences, loopsConfigured: boolean) {
  return {
    productUpdates: prefs.product_updates,
    scanResults: prefs.scan_results,
    scheduleAlerts: prefs.schedule_alerts,
    spendAlerts: prefs.spend_alerts,
    productUpdatesChangedAt: prefs.product_updates_changed_at,
    loopsConfigured,
  };
}

function loopsConfiguredFor(config: EmailConfig): boolean {
  return Boolean(config.apiKey && config.productUpdatesListId);
}

async function flagOn(deps?: PreferencesRouteDeps): Promise<boolean> {
  return (deps?.isFeatureEnabled ?? isFeatureEnabled)("lifecycle_email");
}

async function readOrUnavailable(admin: SupabaseClient, userId: string): Promise<UserEmailPreferences> {
  try {
    return await readPreferences(admin, userId);
  } catch {
    throw new AppError(
      503,
      "preferences_unavailable",
      "Email settings are unavailable right now. Please retry.",
    );
  }
}

export async function GET(request: Request, _ctx?: unknown, deps?: PreferencesRouteDeps): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    const parsedQuery = emailPreferencesQuery.safeParse(Object.fromEntries(query.entries()));
    if (!parsedQuery.success) {
      throw new AppError(400, "invalid_request", "The request was not valid.");
    }
    const { user, admin } = await requireUser(request, deps);
    if (!(await flagOn(deps))) {
      throw new AppError(404, "feature_unavailable", "This page is not available yet.");
    }
    const config = deps?.config ?? readEmailConfig();
    const prefs = await readOrUnavailable(admin, user.id);
    return json(shape(prefs, loopsConfiguredFor(config)));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, _ctx?: unknown, deps?: PreferencesRouteDeps): Promise<Response> {
  try {
    const { user, admin } = await requireUser(request, deps);
    if (!(await flagOn(deps))) {
      throw new AppError(404, "feature_unavailable", "This page is not available yet.");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }
    const parsed = emailPreferencesPutRequest.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "The request was not valid.",
      );
    }
    const config = deps?.config ?? readEmailConfig();
    const loopsDeps = deps?.loops;
    const configured = loopsConfiguredFor(config);
    const { source, productUpdates, scanResults, scheduleAlerts, spendAlerts } = parsed.data;

    let prefs = await readOrUnavailable(admin, user.id);
    let loopsSynced = configured;

    if (productUpdates !== undefined && productUpdates !== prefs.product_updates) {
      if (user.email && configured) {
        const synced = await setProductUpdates(
          admin,
          { id: user.id, email: user.email },
          productUpdates,
          source,
          { config, loops: loopsDeps },
        );
        prefs = synced.preferences;
        loopsSynced = synced.loopsSynced;
      } else {
        try {
          prefs = await savePreferences(admin, user.id, { product_updates: productUpdates }, source);
        } catch {
          throw new AppError(
            503,
            "preferences_unavailable",
            "Email settings are unavailable right now. Please retry.",
          );
        }
        loopsSynced = false;
      }
    }

    const rest: { scan_results?: boolean; schedule_alerts?: boolean; spend_alerts?: boolean } = {};
    if (scanResults !== undefined) rest.scan_results = scanResults;
    if (scheduleAlerts !== undefined) rest.schedule_alerts = scheduleAlerts;
    if (spendAlerts !== undefined) rest.spend_alerts = spendAlerts;
    if (Object.keys(rest).length > 0) {
      try {
        prefs = await savePreferences(admin, user.id, rest, source);
      } catch {
        throw new AppError(
          503,
          "preferences_unavailable",
          "Email settings are unavailable right now. Please retry.",
        );
      }
    }

    trackEmailEvent("email:preferences_changed", {
      product_updates: prefs.product_updates,
      scan_results: prefs.scan_results,
      schedule_alerts: prefs.schedule_alerts,
      spend_alerts: prefs.spend_alerts,
      source,
    });

    return json({ ...shape(prefs, configured), loopsSynced });
  } catch (err) {
    return toErrorResponse(err);
  }
}
