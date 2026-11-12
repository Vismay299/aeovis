"use client";

import { CardShell } from "@/components/app/CardShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/app/CopyButton";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { ExternalLink, Star } from "lucide-react";
import type { SavedBusinessView, BusinessProfileView } from "./hooks/useLocalBusinesses";

export type ProfileTabProps = {
  brandKey: string;
  business: SavedBusinessView;
  ownBusiness: SavedBusinessView | null;
  competitors: SavedBusinessView[];
  onRefreshProfile: (businessId: string, maxUsd?: number) => Promise<unknown>;
  isRefreshingProfile?: boolean;
};

export function ProfileTab({
  brandKey,
  business,
  ownBusiness,
  competitors,
  onRefreshProfile,
  isRefreshingProfile,
}: ProfileTabProps) {
  const profile = business.profile;

  if (!profile) {
    return (
      <CardShell title="Google Business Profile">
        <div className="py-8 text-center space-y-4">
          <p className="text-sm text-muted-foreground">
            No profile data loaded yet for {business.title}.
          </p>
          <PricedActionButton
            label="Load full profile"
            pendingLabel="Loading profile…"
            brandKey={brandKey}
            action="local.profile.lookup"
            input={{
              identifier: business.cid
                ? { cid: business.cid }
                : business.placeId
                ? { placeId: business.placeId }
                : { businessName: business.title },
            }}
            pending={Boolean(isRefreshingProfile)}
            onRun={(maxUsd) => onRefreshProfile(business.id, maxUsd)}
            dialogTitle="Load Google Business Profile"
            confirmLabel="Load profile"
          />
        </div>
      </CardShell>
    );
  }

  // Distribution total for rating bars
  const dist = profile.ratingDistribution;
  const totalVotes =
    profile.rating.votes ??
    (dist ? Object.values(dist).reduce((a, b) => a + b, 0) : 0);

  const daysOrder: Array<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"> = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];

  return (
    <div className="space-y-6" data-slot="profile-tab">
      <CardShell title={profile.title ?? business.title}>
        <div className="space-y-6" data-slot="profile-card">
          <div className="grid gap-6 md:grid-cols-2">
          {/* Left Column: Details */}
          <div className="space-y-4 text-sm">
            <div>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Category
              </span>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <span className="font-medium text-foreground">
                  {profile.category ?? "—"}
                </span>
                {profile.additionalCategories?.map((cat) => (
                  <Badge key={cat} variant="secondary" className="text-xs">
                    {cat}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Rating & Breakdown */}
            <div>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Rating
              </span>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-2xl font-bold text-foreground">
                  {profile.rating.value != null ? profile.rating.value.toFixed(1) : "—"}
                </span>
                <div className="text-xs text-muted-foreground">
                  ★ ({profile.rating.votes ?? 0} reviews)
                </div>
              </div>

              {dist && (
                <div className="space-y-1.5 mt-3 max-w-xs" aria-label="Rating distribution">
                  {(["5", "4", "3", "2", "1"] as const).map((star) => {
                    const count = dist[star] ?? 0;
                    const pct = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
                    return (
                      <div key={star} className="flex items-center gap-2 text-xs">
                        <span className="w-12 text-muted-foreground font-mono">
                          {star}★ {count}
                          <span className="sr-only"> reviews with {star} stars</span>
                        </span>
                        <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-amber-500 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Address & Phone */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Address
                </span>
                <p className="mt-1 text-muted-foreground">
                  {profile.address ?? "—"}
                </p>
              </div>
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Phone
                </span>
                <p className="mt-1 text-muted-foreground">
                  {profile.phone ?? "—"}
                </p>
              </div>
            </div>

            {/* Website & Status */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Website
                </span>
                <div className="mt-1">
                  {profile.website ? (
                    <SafeExternalLink
                      url={profile.website}
                      label={profile.domain ?? profile.website}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Status
                </span>
                <div className="mt-1 flex items-center gap-2">
                  {profile.currentStatus && (
                    <span className="text-foreground">{profile.currentStatus}</span>
                  )}
                  {profile.isClaimed != null && (
                    <Badge variant={profile.isClaimed ? "default" : "outline"} className="text-xs">
                      {profile.isClaimed ? "Claimed" : "Unclaimed"}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* IDs & Links */}
            <div className="pt-2 border-t border-border space-y-2 text-xs">
              {profile.cid && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">CID: {profile.cid}</span>
                  <CopyButton
                    value={profile.cid}
                    successMessage="CID copied"
                    label="Copy CID"
                  />
                </div>
              )}
              {profile.placeId && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    Place ID: {profile.placeId}
                  </span>
                  <CopyButton
                    value={profile.placeId}
                    successMessage="Place ID copied"
                    label="Copy Place ID"
                  />
                </div>
              )}
              {profile.checkUrl && (
                <div className="pt-1">
                  <a
                    href={profile.checkUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    Open on Google Maps
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Hours & Photos */}
          <div className="space-y-4 text-sm">
            <div>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Hours
              </span>
              {profile.hours && profile.hours.length > 0 ? (
                <div className="mt-2 divide-y divide-border rounded-md border border-border text-xs">
                  {daysOrder.map((day) => {
                    const entry = profile.hours?.find(
                      (h) => h.day.toLowerCase() === day
                    );
                    const spans = entry?.spans;
                    const text =
                      spans && spans.length > 0
                        ? spans.map((s) => `${s.open} – ${s.close}`).join(", ")
                        : "Closed";
                    return (
                      <div
                        key={day}
                        className="flex justify-between py-1.5 px-3 capitalize"
                      >
                        <span className="font-medium text-foreground">{day}</span>
                        <span className={text === "Closed" ? "text-muted-foreground" : "text-foreground"}>
                          {text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Hours not listed.
                </p>
              )}
            </div>

            <div>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Photos
              </span>
              <p className="mt-1 text-muted-foreground">
                {profile.totalPhotos != null ? `${profile.totalPhotos} photos` : "—"}
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-border text-xs text-muted-foreground">
          <span>
            {business.profileFetchedAt
              ? `Profile fetched ${new Date(business.profileFetchedAt).toLocaleDateString()}`
              : "Profile fetched"}
          </span>
          <PricedActionButton
            label="Refresh profile"
            pendingLabel="Refreshing…"
            brandKey={brandKey}
            action="local.profile.lookup"
            input={{
              identifier: business.cid
                ? { cid: business.cid }
                : business.placeId
                ? { placeId: business.placeId }
                : { businessName: business.title },
            }}
            pending={Boolean(isRefreshingProfile)}
            onRun={(maxUsd) => onRefreshProfile(business.id, maxUsd)}
            dialogTitle="Refresh Google Business Profile"
            confirmLabel="Refresh profile"
            variant="outline"
          />
        </div>
        </div>
      </CardShell>

      {/* Head to head table with competitors */}
      {competitors.length > 0 && ownBusiness && (
        <div data-slot="head-to-head">
          <CardShell title="Head to head">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2.5 px-3 font-semibold text-muted-foreground">
                    Feature
                  </th>
                  <th className="py-2.5 px-3 font-semibold text-foreground">
                    You ({ownBusiness.title})
                  </th>
                  {competitors.map((c) => (
                    <th key={c.id} className="py-2.5 px-3 font-semibold text-foreground">
                      {c.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Primary category</td>
                  <td className="py-2 px-3">{ownBusiness.profile?.category ?? "—"}</td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.category ?? "—"
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Not loaded</span>
                          <PricedActionButton
                            label="Load"
                            pendingLabel="Loading…"
                            brandKey={brandKey}
                            action="local.profile.lookup"
                            input={{
                              identifier: c.cid
                                ? { cid: c.cid }
                                : c.placeId
                                ? { placeId: c.placeId }
                                : { businessName: c.title },
                            }}
                            pending={Boolean(isRefreshingProfile)}
                            onRun={(maxUsd) => onRefreshProfile(c.id, maxUsd)}
                            dialogTitle={`Load profile for ${c.title}`}
                            confirmLabel="Load"
                            variant="outline"
                          />
                        </div>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Additional categories</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.additionalCategories?.join(", ") || "—"}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.additionalCategories?.join(", ") || "—"
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Rating</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.rating?.value != null
                      ? `★ ${ownBusiness.profile.rating.value}`
                      : "—"}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.rating?.value != null ? `★ ${c.profile.rating.value}` : "—"
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Reviews</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.rating?.votes != null
                      ? ownBusiness.profile.rating.votes
                      : "—"}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.rating?.votes != null ? c.profile.rating.votes : "—"
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Photos</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.totalPhotos != null
                      ? ownBusiness.profile.totalPhotos
                      : "—"}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.totalPhotos != null ? c.profile.totalPhotos : "—"
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Claimed</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.isClaimed != null
                      ? ownBusiness.profile.isClaimed
                        ? "Claimed"
                        : "Unclaimed"
                      : "—"}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.isClaimed != null
                          ? c.profile.isClaimed
                            ? "Claimed"
                            : "Unclaimed"
                          : "—"
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Hours listed</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.hours && ownBusiness.profile.hours.length > 0
                      ? "Yes"
                      : "No"}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.hours && c.profile.hours.length > 0 ? "Yes" : "No"
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="py-2 px-3 text-muted-foreground">Website</td>
                  <td className="py-2 px-3">
                    {ownBusiness.profile?.website ? (
                      <SafeExternalLink
                        url={ownBusiness.profile.website}
                        label={ownBusiness.profile.domain ?? "Website"}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  {competitors.map((c) => (
                    <td key={c.id} className="py-2 px-3">
                      {c.profile ? (
                        c.profile.website ? (
                          <SafeExternalLink
                            url={c.profile.website}
                            label={c.profile.domain ?? "Website"}
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          />
                        ) : (
                          "—"
                        )
                      ) : (
                        <span className="text-muted-foreground">Not loaded</span>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </CardShell>
        </div>
      )}
    </div>
  );
}
