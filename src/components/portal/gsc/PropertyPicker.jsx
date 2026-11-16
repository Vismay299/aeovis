"use client";

/**
 * Property picker shown after Google's OAuth callback (gsc_attempt in the URL).
 * Lists the Search Console properties the signed-in Google account can access.
 */

import { useEffect, useState } from "react";
import { Globe, Link2 } from "lucide-react";
import { Badge, Banner, Button, Card, EmptyState, SkeletonRows } from "../ui";

const PERMISSION_LABELS = {
  siteOwner: "Owner",
  siteFullUser: "Full user",
  siteRestrictedUser: "Restricted user",
};

export default function PropertyPicker({ brandKey, attemptId, website, onConnected, onCancel, onRestart, redirectToLogin }) {
  const [status, setStatus] = useState("loading"); // loading | ready | empty | error
  const [properties, setProperties] = useState([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setStatus("loading");
    setError("");
    const query = `brand_key=${encodeURIComponent(brandKey)}&attempt_id=${encodeURIComponent(attemptId)}`;
    fetch(`/api/customer/gsc/properties?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) { redirectToLogin(); return null; }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load your Google properties.");
        return body;
      })
      .then((body) => {
        if (!live || !body) return;
        const available = (body.properties || []).filter((item) => item.permissionLevel !== "siteUnverifiedUser");
        setProperties(available);
        setSelected(available[0]?.siteUrl || "");
        setStatus(available.length ? "ready" : "empty");
      })
      .catch((failure) => {
        if (!live) return;
        setError(failure.message || "Could not load your Google properties.");
        setStatus("error");
      });
    return () => { live = false; };
  }, [brandKey, attemptId, redirectToLogin]);

  async function connectSelected(event) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/customer/gsc/property", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_key: brandKey, property_id: selected, attempt_id: attemptId }),
      });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not connect this property.");
      onConnected(body.property || { siteUrl: selected });
    } catch (failure) {
      setError(failure.message || "Could not connect this property.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Choose a Search Console property"
      description={website
        ? `Pick the property that matches ${website.replace(/^https?:\/\//, "").replace(/\/$/, "")}.`
        : "Pick the property this workspace should read."}
      footer={status === "ready" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" form="pv-gsc-property-form" icon={Link2} loading={saving} disabled={!selected}>
            Connect selected property
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        </div>
      ) : status === "loading" ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    >
      {error ? <Banner tone="error">{error}</Banner> : null}

      {status === "loading" ? <SkeletonRows rows={3} /> : null}

      {status === "empty" ? (
        <EmptyState
          icon={Globe}
          title="No verified properties found"
          action={<Button variant="secondary" icon={Link2} onClick={onRestart}>Try another Google account</Button>}
        >
          Google only lists Search Console properties that the signed-in account has verified access to.
          Add or verify the site in Search Console with that account, or try a different Google account.
        </EmptyState>
      ) : null}

      {status === "ready" ? (
        <form id="pv-gsc-property-form" onSubmit={connectSelected}>
          <fieldset className="grid min-w-0 gap-2 border-0 p-0">
            <legend className="sr-only">Search Console properties</legend>
            {properties.map((property) => {
              const label = PERMISSION_LABELS[property.permissionLevel] || property.permissionLevel || "Access";
              return (
                <label key={property.siteUrl} className={"flex items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors " + (selected === property.siteUrl ? "border-primary/40 bg-primary/5" : "border-border bg-card hover:bg-muted/40")}>
                  <input
                    type="radio"
                    name="gsc-property"
                    className="m-0 size-4 shrink-0 accent-primary"
                    value={property.siteUrl}
                    checked={selected === property.siteUrl}
                    onChange={() => setSelected(property.siteUrl)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{property.siteUrl}</span>
                  <Badge tone={property.permissionLevel === "siteOwner" ? "brand" : "neutral"}>{label}</Badge>
                </label>
              );
            })}
          </fieldset>
        </form>
      ) : null}
    </Card>
  );
}
