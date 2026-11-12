"use client";

import { useMemo, useState } from "react";
import { CardShell } from "@/components/app/CardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedToggle, type SegmentedToggleItem } from "@/components/app/SegmentedToggle";
import { CountryCombobox } from "@/components/app/CountryCombobox";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { parseMapsLocation } from "@/shared/local-coordinates";
import { DEFAULT_LOCATION_CODE, LOCATION_OPTIONS } from "@/shared/keyword-locations";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { describeError, isSpendRefused, spendRefusedView } from "@/lib/query/errors";
import { toast } from "sonner";
import { Building2, MapPin, Hash, Search } from "lucide-react";
import type { BusinessProfileView, SavedBusinessView } from "./hooks/useLocalBusinesses";
import { CompetitorList } from "./CompetitorList";

export type LocalBusinessRow = {
  title: string | null;
  category: string | null;
  additionalCategories?: string[];
  rating: number | null;
  votes: number | null;
  isClaimed: boolean | null;
  domain: string | null;
  url: string | null;
  phone: string | null;
  address: string | null;
  cid: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  totalPhotos?: number | null;
  checkUrl?: string | null;
  isSaved?: "own" | "competitor" | null;
};

export type BusinessPickerProps = {
  brandKey: string;
  defaultBusinessName?: string;
  ownBusiness: SavedBusinessView | null;
  competitors: SavedBusinessView[];
  selectedBusinessId: string | null;
  onSelectBusinessId: (id: string | null) => void;
  onSaveBusiness: (input: {
    role: "own" | "competitor";
    title: string;
    cid?: string;
    placeId?: string;
    latitude?: number;
    longitude?: number;
    locationCode?: number;
    languageCode?: string;
  }) => Promise<unknown>;
  onRemoveCompetitor: (id: string) => Promise<unknown>;
  onRefreshProfile: (businessId: string, maxUsd?: number) => Promise<unknown>;
  isRefreshingProfile?: boolean;
};

type Mode = "name" | "nearby" | "ids";

const MODES: SegmentedToggleItem<Mode>[] = [
  { value: "name", label: "By name", icon: <Building2 className="h-4 w-4" /> },
  { value: "nearby", label: "Nearby", icon: <MapPin className="h-4 w-4" /> },
  { value: "ids", label: "Google IDs", icon: <Hash className="h-4 w-4" /> },
];

/** Lookups call fetchJson directly, so no global mutation toast reports a
 *  failure (price changed, spend refused, provider down); report it here. */
function reportLookupError(error: unknown) {
  if (isSpendRefused(error)) {
    const view = spendRefusedView(error);
    toast.error(view.title, { description: view.text });
    return;
  }
  toast.error(describeError(error, "The lookup failed. Please retry."));
}

export function BusinessPicker({
  brandKey,
  defaultBusinessName = "",
  ownBusiness,
  competitors,
  selectedBusinessId,
  onSelectBusinessId,
  onSaveBusiness,
  onRemoveCompetitor,
  onRefreshProfile,
  isRefreshingProfile,
}: BusinessPickerProps) {
  const [mode, setMode] = useState<Mode>("name");
  const [showPicker, setShowPicker] = useState(false);
  const [showCompetitorList, setShowCompetitorList] = useState(false);

  // "By name" state
  const [nameInput, setNameInput] = useState(defaultBusinessName);
  const [countryCode, setCountryCode] = useState(DEFAULT_LOCATION_CODE);
  const [nearInput, setNearInput] = useState("");
  const [nameLookupResult, setNameLookupResult] = useState<{
    profile: BusinessProfileView | null;
    searched: boolean;
  }>({ profile: null, searched: false });
  const [isLookingUpName, setIsLookingUpName] = useState(false);

  // "Nearby" state
  const [nearbyNear, setNearbyNear] = useState("");
  const [nearbyRadius, setNearbyRadius] = useState(10);
  const [nearbyQuery, setNearbyQuery] = useState("");
  const [nearbyMinRating, setNearbyMinRating] = useState<number | undefined>(undefined);
  const [nearbyMinReviews, setNearbyMinReviews] = useState<number | undefined>(undefined);
  const [nearbyClaimed, setNearbyClaimed] = useState<"any" | "claimed" | "unclaimed">("any");
  const [nearbySort, setNearbySort] = useState<"relevance" | "rating" | "reviews">("relevance");
  const [nearbyResults, setNearbyResults] = useState<LocalBusinessRow[]>([]);
  const [nearbyOffset, setNearbyOffset] = useState(0);
  const [hasSearchedNearby, setHasSearchedNearby] = useState(false);
  const [isSearchingNearby, setIsSearchingNearby] = useState(false);

  // "Google IDs" state
  const [cidInput, setCidInput] = useState("");
  const [placeIdInput, setPlaceIdInput] = useState("");
  const [idsError, setIdsError] = useState<string | null>(null);
  const [idsLookupResult, setIdsLookupResult] = useState<{
    profile: BusinessProfileView | null;
    searched: boolean;
  }>({ profile: null, searched: false });
  const [isLookingUpIds, setIsLookingUpIds] = useState(false);

  // Parse location inputs
  const parsedNearName = useMemo(() => parseMapsLocation(nearInput), [nearInput]);
  const parsedNearNearby = useMemo(() => parseMapsLocation(nearbyNear), [nearbyNear]);

  // Handle "By name" lookup
  const handleNameLookup = async (maxUsd: number) => {
    setIsLookingUpName(true);
    setNameLookupResult({ profile: null, searched: false });
    try {
      const body: Record<string, unknown> = {
        identifier: { businessName: nameInput.trim() },
        locationCode: countryCode,
        requestId: crypto.randomUUID(),
        maxUsd,
      };
      if (parsedNearName) {
        body.near = {
          latitude: parsedNearName.latitude,
          longitude: parsedNearName.longitude,
          radiusKm: 10,
        };
      }
      const res = await fetchJson<{ profile: BusinessProfileView | null; businessId: string | null }>(
        withBrand("/api/customer/local/profile", brandKey),
        { method: "POST", body }
      );
      setNameLookupResult({ profile: res?.profile ?? null, searched: true });
    } catch (error) {
      reportLookupError(error);
    } finally {
      setIsLookingUpName(false);
    }
  };

  // Handle "Nearby" search
  const handleNearbySearch = async (maxUsd: number, offset = 0) => {
    if (!parsedNearNearby) return;
    setIsSearchingNearby(true);
    try {
      const body: Record<string, unknown> = {
        near: {
          latitude: parsedNearNearby.latitude,
          longitude: parsedNearNearby.longitude,
          radiusKm: nearbyRadius,
        },
        limit: 20,
        offset,
        requestId: crypto.randomUUID(),
        maxUsd,
      };
      if (nearbyQuery.trim()) body.query = nearbyQuery.trim();
      if (nearbyMinRating) body.minRating = nearbyMinRating;
      if (nearbyMinReviews) body.minReviews = nearbyMinReviews;
      if (nearbyClaimed === "claimed") body.isClaimed = true;
      if (nearbyClaimed === "unclaimed") body.isClaimed = false;
      if (nearbySort !== "relevance") body.sortBy = nearbySort;

      const res = await fetchJson<{ businesses: LocalBusinessRow[] }>(
        withBrand("/api/customer/local/listings", brandKey),
        { method: "POST", body }
      );
      setNearbyResults(res?.businesses ?? []);
      setNearbyOffset(offset);
      setHasSearchedNearby(true);
    } catch (error) {
      reportLookupError(error);
    } finally {
      setIsSearchingNearby(false);
    }
  };

  // Handle "Google IDs" lookup
  const handleIdsLookup = async (maxUsd: number) => {
    const hasCid = Boolean(cidInput.trim());
    const hasPlaceId = Boolean(placeIdInput.trim());
    if ((hasCid && hasPlaceId) || (!hasCid && !hasPlaceId)) {
      setIdsError("Provide exactly one business identifier: name, CID or place ID.");
      return;
    }
    setIdsError(null);
    setIsLookingUpIds(true);
    setIdsLookupResult({ profile: null, searched: false });
    try {
      const identifier = hasCid
        ? { cid: cidInput.trim() }
        : { placeId: placeIdInput.trim() };
      const res = await fetchJson<{ profile: BusinessProfileView | null; businessId: string | null }>(
        withBrand("/api/customer/local/profile", brandKey),
        {
          method: "POST",
          body: {
            identifier,
            requestId: crypto.randomUUID(),
            maxUsd,
          },
        }
      );
      setIdsLookupResult({ profile: res?.profile ?? null, searched: true });
    } catch (error) {
      reportLookupError(error);
    } finally {
      setIsLookingUpIds(false);
    }
  };

  // Columns for Nearby results DataTable
  const nearbyColumns = useMemo<ColumnDef<LocalBusinessRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Title",
        cell: ({ row }) => (
          <div className="font-medium text-foreground">
            {row.original.title ?? "Untitled"}
          </div>
        ),
      },
      {
        accessorKey: "category",
        header: "Category",
        cell: ({ row }) => (
          <div className="text-muted-foreground">{row.original.category ?? "—"}</div>
        ),
      },
      {
        accessorKey: "rating",
        header: "Rating",
        cell: ({ row }) => (
          <div>
            {row.original.rating != null ? `★ ${row.original.rating}` : "—"}
          </div>
        ),
      },
      {
        accessorKey: "votes",
        header: "Reviews",
        cell: ({ row }) => (
          <div>{row.original.votes != null ? row.original.votes : "—"}</div>
        ),
      },
      {
        accessorKey: "isClaimed",
        header: "Claimed",
        cell: ({ row }) => (
          <Badge variant={row.original.isClaimed ? "default" : "outline"} className="text-xs">
            {row.original.isClaimed ? "Claimed" : "Unclaimed"}
          </Badge>
        ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        cell: ({ row }) => (
          <div className="text-muted-foreground text-xs">{row.original.phone ?? "—"}</div>
        ),
      },
      {
        accessorKey: "address",
        header: "Address",
        cell: ({ row }) => (
          <div className="text-muted-foreground text-xs max-w-xs truncate">
            {row.original.address ?? "—"}
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (item.title) {
                    await onSaveBusiness({
                      role: "own",
                      title: item.title,
                      cid: item.cid ?? undefined,
                      placeId: item.placeId ?? undefined,
                      latitude: item.latitude ?? undefined,
                      longitude: item.longitude ?? undefined,
                    });
                    setShowPicker(false);
                  }
                }}
              >
                Use as my business
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (item.title) {
                    await onSaveBusiness({
                      role: "competitor",
                      title: item.title,
                      cid: item.cid ?? undefined,
                      placeId: item.placeId ?? undefined,
                      latitude: item.latitude ?? undefined,
                      longitude: item.longitude ?? undefined,
                    });
                  }
                }}
              >
                Save as competitor
              </Button>
            </div>
          );
        },
      },
    ],
    [onSaveBusiness]
  );

  const nearbyTable = useDataTable({
    data: nearbyResults,
    columns: nearbyColumns,
  });

  // When own business is saved and picker is closed, render compact header
  if (ownBusiness && !showPicker) {
    const selectedBusiness =
      selectedBusinessId === null || selectedBusinessId === ownBusiness.id
        ? ownBusiness
        : competitors.find((c) => c.id === selectedBusinessId) ?? ownBusiness;

    const profile = selectedBusiness.profile;
    const isViewingOwn = selectedBusiness.role === "own";

    return (
      <div className="space-y-4" data-slot="business-picker-compact">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {selectedBusiness.title}
              </h2>
              {profile?.isClaimed != null && (
                <Badge
                  variant={profile.isClaimed ? "default" : "outline"}
                  className="text-xs"
                >
                  {profile.isClaimed ? "Claimed" : "Unclaimed"}
                </Badge>
              )}
              {!isViewingOwn && (
                <Badge variant="secondary" className="text-xs">
                  Competitor
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {profile?.category && <span>{profile.category}</span>}
              {profile?.rating?.value != null && (
                <span>
                  ★ {profile.rating.value} ({profile.rating.votes ?? 0} reviews)
                </span>
              )}
              {profile?.address && <span>· {profile.address}</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {profile === null && (
              <PricedActionButton
                label="Load full profile"
                pendingLabel="Loading profile…"
                brandKey={brandKey}
                action="local.profile.lookup"
                input={{
                  identifier: selectedBusiness.cid
                    ? { cid: selectedBusiness.cid }
                    : selectedBusiness.placeId
                    ? { placeId: selectedBusiness.placeId }
                    : { businessName: selectedBusiness.title },
                }}
                pending={Boolean(isRefreshingProfile)}
                onRun={(maxUsd) => onRefreshProfile(selectedBusiness.id, maxUsd)}
                dialogTitle="Load Google Business Profile"
                confirmLabel="Load profile"
              />
            )}

            {competitors.length > 0 && (
              <Select
                value={selectedBusinessId ?? ownBusiness.id}
                onValueChange={(val) =>
                  onSelectBusinessId(val === ownBusiness.id ? null : val)
                }
              >
                <SelectTrigger className="w-52 h-8 text-xs">
                  <SelectValue placeholder="Viewing: Your business" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ownBusiness.id} className="text-xs">
                    Viewing: {ownBusiness.title} (Your business)
                  </SelectItem>
                  {competitors.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">
                      Viewing: {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCompetitorList(!showCompetitorList)}
            >
              Competitors ({competitors.length})
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPicker(true)}
            >
              Change business
            </Button>
          </div>
        </div>

        {showCompetitorList && (
          <div className="rounded-lg border border-border bg-card p-4">
            <CompetitorList
              competitors={competitors}
              onRemove={onRemoveCompetitor}
            />
          </div>
        )}
      </div>
    );
  }

  // Find business picker card
  return (
    <CardShell title="Find your business on Google">
      <div className="space-y-6" data-slot="business-picker">
        <div className="flex items-center justify-between">
        <SegmentedToggle<Mode>
          items={MODES}
          value={mode}
          onChange={setMode}
          showLabels
        />
        {ownBusiness && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPicker(false)}
          >
            Cancel
          </Button>
        )}
      </div>

      {mode === "name" && (
        <div className="space-y-4" data-slot="mode-name">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="business-name">Business name</Label>
              <Input
                id="business-name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Business name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="business-country">Country</Label>
              <CountryCombobox
                id="business-country"
                value={countryCode}
                onChange={setCountryCode}
                options={LOCATION_OPTIONS}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="business-near">
              Near (Google Maps link or coordinates)
            </Label>
            <Input
              id="business-near"
              value={nearInput}
              onChange={(e) => setNearInput(e.target.value)}
              placeholder="Paste full Google Maps link or e.g. 19.0760, 72.8777"
            />
            <p className="text-xs text-muted-foreground">
              Paste the full Google Maps link from your browser's address bar, or coordinates like 19.0760, 72.8777.
            </p>
          </div>

          <div className="flex justify-end">
            <PricedActionButton
              label="Find business"
              pendingLabel="Finding business…"
              brandKey={brandKey}
              action="local.profile.lookup"
              input={{
                identifier: { businessName: nameInput.trim() },
                locationCode: countryCode,
                near: parsedNearName
                  ? {
                      latitude: parsedNearName.latitude,
                      longitude: parsedNearName.longitude,
                      radiusKm: 10,
                    }
                  : undefined,
              }}
              enabled={Boolean(nameInput.trim())}
              pending={isLookingUpName}
              onRun={handleNameLookup}
              dialogTitle="Find Google Business Profile"
              confirmLabel="Find business"
            />
          </div>

          {nameLookupResult.searched && (
            <div className="mt-4" data-slot="lookup-result">
              {nameLookupResult.profile ? (
                <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-foreground">
                        {nameLookupResult.profile.title}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {nameLookupResult.profile.category}
                        {nameLookupResult.profile.rating?.value != null && (
                          <span> · ★ {nameLookupResult.profile.rating.value} ({nameLookupResult.profile.rating.votes ?? 0})</span>
                        )}
                      </p>
                      {nameLookupResult.profile.address && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {nameLookupResult.profile.address}
                        </p>
                      )}
                    </div>
                    {nameLookupResult.profile.isClaimed != null && (
                      <Badge
                        variant={nameLookupResult.profile.isClaimed ? "default" : "outline"}
                      >
                        {nameLookupResult.profile.isClaimed ? "Claimed" : "Unclaimed"}
                      </Badge>
                    )}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        const prof = nameLookupResult.profile;
                        if (prof?.title) {
                          await onSaveBusiness({
                            role: "own",
                            title: prof.title,
                            cid: prof.cid ?? undefined,
                            placeId: prof.placeId ?? undefined,
                            latitude: prof.latitude ?? undefined,
                            longitude: prof.longitude ?? undefined,
                            locationCode: countryCode,
                          });
                          setShowPicker(false);
                        }
                      }}
                    >
                      This is my business
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setNameLookupResult({ profile: null, searched: false })
                      }
                    >
                      Not it
                    </Button>
                  </div>
                </div>
              ) : (
                <Alert className="text-sm">
                  No Google Business Profile matched that name. Try the exact name shown on Google Maps, add a Maps link, or search nearby businesses.
                </Alert>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "nearby" && (
        <div className="space-y-4" data-slot="mode-nearby">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nearby-near">Near (required)</Label>
              <Input
                id="nearby-near"
                value={nearbyNear}
                onChange={(e) => setNearbyNear(e.target.value)}
                placeholder="Google Maps link or lat, lng (e.g. 19.0760, 72.8777)"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nearby-radius">Radius (km)</Label>
              <Input
                id="nearby-radius"
                type="number"
                min={1}
                max={50}
                value={nearbyRadius}
                onChange={(e) => setNearbyRadius(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="nearby-query">Name or text</Label>
              <Input
                id="nearby-query"
                value={nearbyQuery}
                onChange={(e) => setNearbyQuery(e.target.value)}
                placeholder="Optional filter query"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nearby-claimed">Claimed</Label>
              <Select
                value={nearbyClaimed}
                onValueChange={(val) => {
                  if (val) setNearbyClaimed(val as "any" | "claimed" | "unclaimed");
                }}
              >
                <SelectTrigger id="nearby-claimed">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="claimed">Claimed</SelectItem>
                  <SelectItem value="unclaimed">Unclaimed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nearby-sort">Sort</Label>
              <Select
                value={nearbySort}
                onValueChange={(val) => {
                  if (val) setNearbySort(val as "relevance" | "rating" | "reviews");
                }}
              >
                <SelectTrigger id="nearby-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relevance">Relevance</SelectItem>
                  <SelectItem value="rating">Rating</SelectItem>
                  <SelectItem value="reviews">Reviews</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex justify-end">
            <PricedActionButton
              label="Search businesses"
              pendingLabel="Searching…"
              brandKey={brandKey}
              action="local.listings.search"
              input={{
                near: parsedNearNearby
                  ? {
                      latitude: parsedNearNearby.latitude,
                      longitude: parsedNearNearby.longitude,
                      radiusKm: nearbyRadius,
                    }
                  : { latitude: 0, longitude: 0, radiusKm: nearbyRadius },
                query: nearbyQuery.trim() || undefined,
                limit: 20,
                offset: 0,
              }}
              enabled={Boolean(parsedNearNearby)}
              pending={isSearchingNearby}
              onRun={(maxUsd) => handleNearbySearch(maxUsd, 0)}
              dialogTitle="Search Nearby Businesses"
              confirmLabel="Search businesses"
            />
          </div>

          {hasSearchedNearby && (
            <div className="space-y-4 pt-2" data-slot="nearby-results">
              {nearbyResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No businesses found here. Widen the radius or remove filters.
                </p>
              ) : (
                <>
                  <DataTable
                    table={nearbyTable}
                    empty={{
                      title: "No businesses found here.",
                      description: "Widen the radius or remove filters.",
                    }}
                  />
                  <div className="flex justify-end">
                    <PricedActionButton
                      label="Next 20"
                      pendingLabel="Loading next page…"
                      brandKey={brandKey}
                      action="local.listings.search"
                      input={{
                        near: parsedNearNearby
                          ? {
                              latitude: parsedNearNearby.latitude,
                              longitude: parsedNearNearby.longitude,
                              radiusKm: nearbyRadius,
                            }
                          : { latitude: 0, longitude: 0, radiusKm: nearbyRadius },
                        query: nearbyQuery.trim() || undefined,
                        limit: 20,
                        offset: nearbyOffset + 20,
                      }}
                      enabled={Boolean(parsedNearNearby)}
                      pending={isSearchingNearby}
                      onRun={(maxUsd) =>
                        handleNearbySearch(maxUsd, nearbyOffset + 20)
                      }
                      dialogTitle="Search Next 20 Businesses"
                      confirmLabel="Next 20"
                      variant="outline"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "ids" && (
        <div className="space-y-4" data-slot="mode-ids">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="business-cid">CID</Label>
              <Input
                id="business-cid"
                value={cidInput}
                onChange={(e) => {
                  setCidInput(e.target.value);
                  setIdsError(null);
                }}
                placeholder="Google CID number (e.g. 1234567890)"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="business-placeid">Place ID</Label>
              <Input
                id="business-placeid"
                value={placeIdInput}
                onChange={(e) => {
                  setPlaceIdInput(e.target.value);
                  setIdsError(null);
                }}
                placeholder="Google Place ID (e.g. ChIJ...)"
              />
            </div>
          </div>

          {idsError && (
            <p className="text-xs text-destructive">{idsError}</p>
          )}

          <div className="flex justify-end">
            <PricedActionButton
              label="Find business"
              pendingLabel="Finding business…"
              brandKey={brandKey}
              action="local.profile.lookup"
              input={{
                identifier: cidInput.trim()
                  ? { cid: cidInput.trim() }
                  : placeIdInput.trim()
                  ? { placeId: placeIdInput.trim() }
                  : { businessName: "" },
              }}
              enabled={Boolean(cidInput.trim() || placeIdInput.trim())}
              pending={isLookingUpIds}
              onRun={handleIdsLookup}
              dialogTitle="Find Google Business Profile"
              confirmLabel="Find business"
            />
          </div>

          {idsLookupResult.searched && (
            <div className="mt-4" data-slot="ids-result">
              {idsLookupResult.profile ? (
                <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-foreground">
                        {idsLookupResult.profile.title}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {idsLookupResult.profile.category}
                        {idsLookupResult.profile.rating?.value != null && (
                          <span> · ★ {idsLookupResult.profile.rating.value} ({idsLookupResult.profile.rating.votes ?? 0})</span>
                        )}
                      </p>
                      {idsLookupResult.profile.address && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {idsLookupResult.profile.address}
                        </p>
                      )}
                    </div>
                    {idsLookupResult.profile.isClaimed != null && (
                      <Badge
                        variant={idsLookupResult.profile.isClaimed ? "default" : "outline"}
                      >
                        {idsLookupResult.profile.isClaimed ? "Claimed" : "Unclaimed"}
                      </Badge>
                    )}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        const prof = idsLookupResult.profile;
                        if (prof?.title) {
                          await onSaveBusiness({
                            role: "own",
                            title: prof.title,
                            cid: prof.cid ?? undefined,
                            placeId: prof.placeId ?? undefined,
                            latitude: prof.latitude ?? undefined,
                            longitude: prof.longitude ?? undefined,
                          });
                          setShowPicker(false);
                        }
                      }}
                    >
                      This is my business
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setIdsLookupResult({ profile: null, searched: false })
                      }
                    >
                      Not it
                    </Button>
                  </div>
                </div>
              ) : (
                <Alert className="text-sm">
                  No Google Business Profile matched that name. Try the exact name shown on Google Maps, add a Maps link, or search nearby businesses.
                </Alert>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </CardShell>
  );
}
