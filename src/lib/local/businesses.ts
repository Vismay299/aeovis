// Saved own/competitor businesses (F17 §6.2.8). Identity only: the profile is
// written exclusively by server code that fetched it (profile.ts).

import { AppError } from "../http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import type { BusinessProfileView } from "./profile.ts";
import {
  localStoreFor,
  type BusinessRole,
  type BusinessRow,
  type LocalDeps,
} from "./store.ts";

export type SavedBusinessView = {
  id: string;
  role: BusinessRole;
  title: string;
  cid: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  locationCode: number | null;
  languageCode: string;
  profile: BusinessProfileView | null;
  profileFetchedAt: string | null;
};

type Ws = Pick<Workspace, "brandKey" | "admin"> & Partial<Pick<Workspace, "user">>;

export function businessNotFound(): AppError {
  return new AppError(404, "business_not_found", "That business is not saved in this workspace.");
}

export function toSavedBusinessView(row: BusinessRow): SavedBusinessView {
  return {
    id: row.id,
    role: row.role,
    title: row.title,
    cid: row.cid,
    placeId: row.place_id,
    latitude: row.latitude,
    longitude: row.longitude,
    locationCode: row.location_code,
    languageCode: row.language_code,
    profile: (row.profile as BusinessProfileView | null) ?? null,
    profileFetchedAt: row.profile_fetched_at,
  };
}

/** Own business first, then competitors by title. */
export async function listBusinesses(ws: Ws, deps?: LocalDeps): Promise<SavedBusinessView[]> {
  const rows = await localStoreFor(ws, deps).listBusinesses(ws.brandKey);
  return rows
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "own" ? -1 : 1;
      return a.title.localeCompare(b.title);
    })
    .map(toSavedBusinessView);
}

export async function saveBusiness(
  ws: Ws,
  i: {
    role: BusinessRole;
    title: string;
    cid?: string;
    placeId?: string;
    latitude?: number;
    longitude?: number;
    locationCode?: number;
    languageCode?: string;
  },
  deps?: LocalDeps,
): Promise<SavedBusinessView> {
  if (!i.cid && !i.placeId) {
    throw new AppError(
      400,
      "identifier_required",
      "Provide exactly one business identifier: name, CID or place ID.",
    );
  }
  const store = localStoreFor(ws, deps);
  const id = await store.saveBusiness({
    brandKey: ws.brandKey,
    role: i.role,
    title: i.title,
    cid: i.cid ?? null,
    placeId: i.placeId ?? null,
    latitude: i.latitude ?? null,
    longitude: i.longitude ?? null,
    locationCode: i.locationCode ?? null,
    languageCode: i.languageCode ?? null,
    profile: null, // identity only; profile data comes from a server fetch
    actor: ws.user?.id ?? null,
  });
  const row = await store.getBusiness(ws.brandKey, id);
  if (!row) throw businessNotFound();
  return toSavedBusinessView(row);
}

export async function updateBusinessRole(
  ws: Ws,
  businessId: string,
  role: BusinessRole,
  deps?: LocalDeps,
): Promise<SavedBusinessView> {
  const store = localStoreFor(ws, deps);
  const row = await store.getBusiness(ws.brandKey, businessId);
  if (!row) throw businessNotFound();
  await store.saveBusiness({
    brandKey: ws.brandKey,
    role,
    title: row.title,
    cid: row.cid,
    placeId: row.place_id,
    profile: null,
    actor: ws.user?.id ?? null,
  });
  const updated = await store.getBusiness(ws.brandKey, businessId);
  if (!updated) throw businessNotFound();
  return toSavedBusinessView(updated);
}

export async function removeBusiness(ws: Ws, businessId: string, deps?: LocalDeps): Promise<void> {
  const removed = await localStoreFor(ws, deps).removeBusiness(ws.brandKey, businessId);
  if (!removed) throw businessNotFound();
}
