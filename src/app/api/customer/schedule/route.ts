// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilitySchedule.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, jsonOk, AppError } from "../../../../lib/http/errors.ts";
import { isFeatureEnabled, type FeatureFlagDeps } from "../../../../lib/features/flags.ts";
import {
  getCustomerSchedule,
  saveCustomerSchedule,
  type CustomerScheduleView,
  type SaveCustomerScheduleDeps,
} from "../../../../lib/schedules/customerSchedule.ts";
import {
  getScheduleQuery,
  saveScheduleBody,
} from "../../../../lib/schedules/schedule.contract.ts";
import { captureServerEvent } from "../../../../lib/telemetry/server.ts";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export type ScheduleRouteDeps = RequireWorkspaceDeps &
  SaveCustomerScheduleDeps & {
    requireWorkspace?: typeof requireWorkspace;
    isFeatureEnabled?: typeof isFeatureEnabled;
    getCustomerSchedule?: typeof getCustomerSchedule;
    saveCustomerSchedule?: typeof saveCustomerSchedule;
  };

function toFlagDeps(deps?: ScheduleRouteDeps): FeatureFlagDeps | undefined {
  if (!deps) return undefined;
  return {
    env: deps.env,
    now: deps.now ? () => deps.now!().getTime() : undefined,
  };
}

async function readBody(request: Request): Promise<unknown> {
  let text = "";
  try {
    text = await request.text();
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON.");
  }
}

export async function GET(request: Request, _ctx: unknown, deps?: ScheduleRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKeyParam = url.searchParams.get("brand_key") ?? undefined;

    const queryParsed = getScheduleQuery.safeParse({ brand_key: brandKeyParam });
    if (!queryParsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.", {
        details: { issues: queryParsed.error.issues },
      });
    }

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const ws = await loadWorkspace(request, { brandKey: queryParsed.data.brand_key }, deps);

    const checkFeature = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const enabled = await checkFeature("customer_scheduling", ws.brandKey, toFlagDeps(deps));
    if (!enabled) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const getFn = deps?.getCustomerSchedule ?? getCustomerSchedule;
    const schedule = await getFn(ws.admin, ws);
    return jsonOk(schedule);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, _ctx: unknown, deps?: ScheduleRouteDeps): Promise<Response> {
  try {
    const raw = await readBody(request);
    const parsed = saveScheduleBody.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid schedule update request.", {
        details: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const ws = await loadWorkspace(request, { brandKey: body.brand_key }, deps);

    const checkFeature = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const enabled = await checkFeature("customer_scheduling", ws.brandKey, toFlagDeps(deps));
    if (!enabled) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    // F26 §6.2.7 `schedule:changed` needs the previous interval, and the save
    // returns only the new view. This read is best effort: it never fails or
    // changes the save, and when it fails the event is `schedule:enabled`.
    let previous: CustomerScheduleView | null = null;
    if (body.enabled) {
      try {
        previous = await (deps?.getCustomerSchedule ?? getCustomerSchedule)(ws.admin, ws);
      } catch {
        previous = null;
      }
    }

    const saveFn = deps?.saveCustomerSchedule ?? saveCustomerSchedule;
    const result = await saveFn(ws.admin, ws, body, deps);

    try {
      const identity = { userId: ws.user.id, brandKey: ws.brandKey };
      if (!body.enabled) {
        void captureServerEvent({ name: "schedule:paused", props: {}, ...identity }).catch(() => {});
      } else if (body.interval) {
        const intervalChanged = Boolean(previous?.interval) && previous?.interval !== body.interval;
        if (intervalChanged) {
          void captureServerEvent({
            name: "schedule:changed",
            props: { interval: body.interval },
            ...identity,
          }).catch(() => {});
        } else {
          void captureServerEvent({
            name: "schedule:enabled",
            props: { interval: body.interval, approved_usd: result.approvedMaxUsd ?? body.maxUsd ?? 0 },
            ...identity,
          }).catch(() => {});
        }
      }
    } catch {
      // Telemetry never changes the response.
    }

    return jsonOk(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
