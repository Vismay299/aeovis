// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-shared.ts, src/server/mcp/table.ts, src/server/mcp/tools/dataforseo-research-tools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../../shared/http/appError.ts";

export const BUSINESS_DATA_MIN_RADIUS_M = 200;
export const BUSINESS_DATA_MAX_RADIUS_M = 199_999;
export const BUSINESS_DATA_DEFAULT_RADIUS_KM = 10;
export const DEFAULT_LOCAL_SERP_ZOOM = 12;

export function formatCoordinate(value: number): string {
  return Number(value.toFixed(7)).toString();
}

export const nearSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusKm: z.number().min(0.2).max(199).optional(),
});

export const listingsNearSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusKm: z.number().min(1).max(100),
});

export const localSerpNearSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  zoom: z.number().int().min(4).max(18).optional(),
});

export function formatBusinessDataCoordinate(near: {
  latitude: number;
  longitude: number;
  radiusKm?: number;
}): string {
  const radius = Math.min(
    BUSINESS_DATA_MAX_RADIUS_M,
    Math.max(
      BUSINESS_DATA_MIN_RADIUS_M,
      Math.round((near.radiusKm ?? BUSINESS_DATA_DEFAULT_RADIUS_KM) * 1000),
    ),
  );
  return `${formatCoordinate(near.latitude)},${formatCoordinate(near.longitude)},${radius}`;
}

export function formatBusinessListingsCoordinate(near: {
  latitude: number;
  longitude: number;
  radiusKm: number;
}): string {
  const radiusKm = Math.max(1, Math.round(near.radiusKm));
  return `${formatCoordinate(near.latitude)},${formatCoordinate(near.longitude)},${radiusKm}`;
}

export function formatLocalSerpCoordinate(near: {
  latitude: number;
  longitude: number;
  zoom?: number;
}): string {
  const coordinate = `${formatCoordinate(near.latitude)},${formatCoordinate(near.longitude)}`;
  return near.zoom == null ? coordinate : `${coordinate},${near.zoom}z`;
}

export const businessIdentifierSchema = z.object({
  businessName: z.string().min(1).max(200).optional(),
  cid: z.string().regex(/^[0-9]{1,30}$/).optional(),
  placeId: z.string().min(1).max(256).optional(),
});

export type ResolvedBusinessIdentifier = {
  keyword?: string;
  cid?: string;
  placeId?: string;
};

export function resolveBusinessIdentifier(args: {
  businessName?: string;
  cid?: string;
  placeId?: string;
}): ResolvedBusinessIdentifier {
  const supplied = [args.businessName, args.cid, args.placeId].filter(
    (value) => value != null && value !== "",
  );
  if (supplied.length !== 1) {
    throw new AppError(
      400,
      "identifier_required",
      "Provide exactly one business identifier: name, CID or place ID.",
    );
  }
  return { keyword: args.businessName, cid: args.cid, placeId: args.placeId };
}

export function businessIdentifierKeyword(
  identifier: ResolvedBusinessIdentifier,
): string {
  if (identifier.cid != null && identifier.cid !== "") return `cid:${identifier.cid}`;
  if (identifier.placeId != null && identifier.placeId !== "") return `place_id:${identifier.placeId}`;
  return identifier.keyword ?? "";
}

export function readPath(source: unknown, ...path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

export function pickRowFields(
  row: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const field of fields) {
    const value = readPath(row, field);
    if (value !== undefined) trimmed[field] = value;
  }
  return trimmed;
}
