// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.ts:127-252
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { getLanguageCode, workspaceMarket } from "../../shared/keyword-locations.ts";
import { safeHttpUrl } from "../../shared/safe-url.ts";
import { createBusinessClient, type BusinessClient } from "../providers/dataforseo/business.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { AppError } from "../http/appError.ts";
import { toResearchError } from "../research/providerErrors.ts";
import { businessNotFound } from "./businesses.ts";
import { appendLocalResearch, profileResearchKey, profileResearchSummary } from "./research.ts";
import {
  businessIdentifierKeyword,
  formatBusinessDataCoordinate,
  readPath,
  resolveBusinessIdentifier,
} from "./shared.ts";
import {
  LOCAL_UNAVAILABLE_MESSAGE,
  localStoreFor,
  type LocalDeps,
} from "./store.ts";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type Day = (typeof DAYS)[number];

export type BusinessProfileView = {
  title: string | null;
  category: string | null;
  additionalCategories: string[];
  rating: { value: number | null; votes: number | null };
  ratingDistribution: Record<"1" | "2" | "3" | "4" | "5", number> | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  domain: string | null;
  isClaimed: boolean | null;
  currentStatus: string | null;
  hours: Array<{ day: Day; spans: Array<{ open: string; close: string }> }> | null;
  totalPhotos: number | null;
  cid: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  checkUrl: string | null;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clock(value: unknown): string | null {
  const hour = num(readPath(value, "hour"));
  const minute = num(readPath(value, "minute"));
  if (hour == null) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

function toHours(workHours: unknown): BusinessProfileView["hours"] {
  const timetable = readPath(workHours, "timetable");
  if (typeof timetable !== "object" || timetable === null) return null;
  return DAYS.map((day) => {
    const raw = Reflect.get(timetable, day);
    const spans: Array<{ open: string; close: string }> = [];
    if (Array.isArray(raw)) {
      for (const span of raw) {
        const open = clock(readPath(span, "open"));
        const close = clock(readPath(span, "close"));
        if (open && close) spans.push({ open, close });
      }
    }
    return { day, spans };
  });
}

function toRatingDistribution(raw: unknown): BusinessProfileView["ratingDistribution"] {
  if (typeof raw !== "object" || raw === null) return null;
  const out = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let any = false;
  for (const key of ["1", "2", "3", "4", "5"] as const) {
    const value = num(Reflect.get(raw, key));
    if (value != null) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : null;
}

/** Structured profile from a `my_business_info` item (OpenSEO formatProfileText/Timetable/RatingDistribution). */
export function toProfileView(raw: Record<string, unknown>): BusinessProfileView {
  const additional = readPath(raw, "additional_categories");
  const claimed = readPath(raw, "is_claimed");
  return {
    title: str(raw.title),
    category: str(raw.category),
    additionalCategories: Array.isArray(additional)
      ? additional.filter((c): c is string => typeof c === "string")
      : [],
    rating: { value: num(readPath(raw, "rating", "value")), votes: num(readPath(raw, "rating", "votes_count")) },
    ratingDistribution: toRatingDistribution(raw.rating_distribution),
    address: str(raw.address),
    phone: str(raw.phone),
    website: safeHttpUrl(str(raw.url)),
    domain: str(raw.domain),
    isClaimed: typeof claimed === "boolean" ? claimed : null,
    currentStatus: str(readPath(raw, "work_hours", "current_status")),
    hours: toHours(raw.work_hours),
    totalPhotos: num(raw.total_photos),
    cid: str(raw.cid),
    placeId: str(raw.place_id),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    checkUrl: safeHttpUrl(str(raw.check_url)),
  };
}

type Ws = Pick<Workspace, "brandKey" | "brand" | "admin"> & Partial<Pick<Workspace, "user">>;
type ResearchWs = Ws & Pick<Workspace, "user">;

function unavailable(err: unknown): unknown {
  return toResearchError(err, {
    unavailableCode: "local_unavailable",
    unavailableMessage: LOCAL_UNAVAILABLE_MESSAGE,
  });
}

function businessClient(deps?: LocalDeps): BusinessClient {
  return deps?.business ?? createBusinessClient();
}

export async function lookupBusinessProfile(
  ws: ResearchWs,
  i: {
    identifier: { businessName?: string; cid?: string; placeId?: string };
    near?: { latitude: number; longitude: number; radiusKm?: number };
    locationCode?: number;
    languageCode?: string;
    save?: "own" | "competitor";
    maxUsd?: number;
    requestId: string;
  },
  deps?: LocalDeps,
): Promise<{ profile: BusinessProfileView | null; businessId: string | null }> {
  const identifier = resolveBusinessIdentifier(i.identifier);
  const market = workspaceMarket(ws.brand);
  const locationCode = i.locationCode ?? market.locationCode;
  const languageCode = i.languageCode ?? (i.locationCode != null ? getLanguageCode(locationCode) : market.languageCode);

  let raw: Record<string, unknown> | null;
  try {
    raw = await businessClient(deps).myBusinessInfo(
      {
        brandKey: ws.brandKey,
        feature: "local.business",
        idempotencyKey: `local.profile:${i.requestId}`,
        maxUsd: i.maxUsd,
      },
      {
        keyword: businessIdentifierKeyword(identifier),
        ...(i.near ? { locationCoordinate: formatBusinessDataCoordinate(i.near) } : { locationCode }),
        languageCode,
      },
    );
  } catch (err) {
    throw unavailable(err);
  }

  const researchKey = profileResearchKey({
    cid: identifier.cid,
    placeId: identifier.placeId,
    name: identifier.keyword,
  });

  if (!raw) {
    await appendLocalResearch(
      ws,
      {
        kind: "local.business",
        researchKey,
        summary: profileResearchSummary({ identifier: identifier.cid ?? identifier.placeId ?? identifier.keyword }),
      },
      deps,
    );
    return { profile: null, businessId: null };
  }

  const profile = toProfileView(raw);
  let businessId: string | null = null;
  if (i.save && (profile.cid || profile.placeId)) {
    businessId = await localStoreFor(ws, deps).saveBusiness({
      brandKey: ws.brandKey,
      role: i.save,
      title: (profile.title ?? identifier.keyword ?? "Business").slice(0, 300),
      cid: profile.cid,
      placeId: profile.placeId,
      latitude: profile.latitude,
      longitude: profile.longitude,
      locationCode: i.near ? null : locationCode,
      languageCode,
      profile,
      actor: ws.user.id,
    });
  }

  await appendLocalResearch(
    ws,
    {
      kind: "local.business",
      researchKey,
      summary: profileResearchSummary({
        title: profile.title,
        category: profile.category,
        rating: profile.rating.value,
        votes: profile.rating.votes,
      }),
    },
    deps,
  );
  return { profile, businessId };
}

export async function refreshBusinessProfile(
  ws: ResearchWs,
  businessId: string,
  i: { maxUsd?: number; requestId: string },
  deps?: LocalDeps,
): Promise<BusinessProfileView | null> {
  const store = localStoreFor(ws, deps);
  const business = await store.getBusiness(ws.brandKey, businessId);
  if (!business) throw businessNotFound();
  const identifier = business.cid
    ? { cid: business.cid }
    : business.place_id
      ? { placeId: business.place_id }
      : null;
  if (!identifier) throw new AppError(400, "identifier_required", "Provide exactly one business identifier: name, CID or place ID.");

  const market = workspaceMarket(ws.brand);
  const hasCoordinate = business.latitude != null && business.longitude != null;
  let raw: Record<string, unknown> | null;
  try {
    raw = await businessClient(deps).myBusinessInfo(
      {
        brandKey: ws.brandKey,
        feature: "local.business",
        idempotencyKey: `local.profile:${i.requestId}`,
        maxUsd: i.maxUsd,
      },
      {
        keyword: businessIdentifierKeyword(identifier),
        ...(hasCoordinate
          ? {
              locationCoordinate: formatBusinessDataCoordinate({
                latitude: business.latitude as number,
                longitude: business.longitude as number,
              }),
            }
          : { locationCode: business.location_code ?? market.locationCode }),
        languageCode: business.language_code || market.languageCode,
      },
    );
  } catch (err) {
    throw unavailable(err);
  }

  const researchKey = profileResearchKey(identifier);
  if (!raw) {
    await appendLocalResearch(
      ws,
      { kind: "local.business", researchKey, summary: profileResearchSummary({ identifier: business.cid ?? business.place_id ?? undefined }) },
      deps,
    );
    return null;
  }
  const profile = toProfileView(raw);
  await store.saveBusiness({
    brandKey: ws.brandKey,
    role: business.role,
    title: business.title,
    cid: business.cid,
    placeId: business.place_id,
    // The profile supplies coordinates for businesses saved from IDs alone (Q&A needs them); nulls keep what is stored.
    latitude: profile.latitude,
    longitude: profile.longitude,
    profile,
    actor: ws.user.id,
  });
  await appendLocalResearch(
    ws,
    {
      kind: "local.business",
      researchKey,
      summary: profileResearchSummary({
        title: profile.title,
        category: profile.category,
        rating: profile.rating.value,
        votes: profile.rating.votes,
      }),
    },
    deps,
  );
  return profile;
}
