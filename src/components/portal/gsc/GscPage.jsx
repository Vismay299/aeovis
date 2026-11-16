"use client";

/**
 * /portal/search-console: connect, inspect and sync the brand's Google Search
 * Console property. OAuth wiring mirrors the routes under /api/customer/gsc.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, Link2, RefreshCw, Search, ShieldCheck, Unplug } from "lucide-react";
import { usePortal } from "../PortalShell";
import { Badge, Banner, Button, Card, PageHeader, SkeletonRows, formatDate, formatRelative } from "../ui";
import PropertyPicker from "./PropertyPicker";
import PerformanceCard from "./PerformanceCard";
import { trackEvent } from "@/lib/telemetry/client";

const CALLBACK_PARAMS = ["gsc_attempt", "gsc_connected", "gsc_error", "brand_key"];
const JSON_HEADERS = { "Content-Type": "application/json" };

function readCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  return { attempt: params.get("gsc_attempt") || "", error: params.get("gsc_error") || "" };
}

function stripCallbackParams() {
  const url = new URL(window.location.href);
  for (const key of CALLBACK_PARAMS) url.searchParams.delete(key);
  window.history.replaceState(null, "", url);
}

function syncStatus(connection) {
  if (connection?.last_status === "failed") return { tone: "crit", label: "Last sync failed" };
  if (!connection?.last_status) return { tone: "neutral", label: "Waiting for first sync" };
  return { tone: "good", label: "Synced" };
}

export default function GscPage() {
  const { brandKey, brand, isOwner, gsc, refreshGsc, redirectToLogin } = usePortal();

  // null until the browser has read the OAuth callback parameters.
  const [callback, setCallback] = useState(null);
  const [banner, setBanner] = useState(null); // { tone, text }
  const [busy, setBusy] = useState(""); // connect | sync | disconnect

  useEffect(() => {
    setCallback(readCallbackParams());
  }, []);

  const pickerOpen = !!(callback?.attempt && isOwner);
  const connection = gsc?.connection || null;
  const connected = !!gsc?.connected;
  const syncKey = `${connection?.last_attempt_at || ""}|${connection?.last_ingested_through || ""}`;

  const startConnect = useCallback(async () => {
    setBusy("connect");
    setBanner(null);
    trackEvent("gsc:connect_start", {});
    try {
      const response = await fetch("/api/customer/gsc/connect", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ brand_key: brandKey }),
      });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.authorization_url) {
        throw new Error(body.error || "Could not start the Google authorization flow.");
      }
      // Stay in the busy state while the browser leaves for Google.
      window.location.href = body.authorization_url;
    } catch (error) {
      setBanner({ tone: "error", text: error.message || "Could not start Google Search Console connection." });
      setBusy("");
    }
  }, [brandKey, redirectToLogin]);

  async function syncNow() {
    setBusy("sync");
    setBanner(null);
    try {
      const response = await fetch("/api/customer/gsc/sync", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ brand_key: brandKey }),
      });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not start a sync.");
      setBanner({
        tone: "success",
        text: body.queued
          ? "Sync queued. New Search Console data usually appears within a few minutes."
          : body.message || "A sync is already in progress.",
      });
      await refreshGsc();
    } catch (error) {
      setBanner({ tone: "error", text: error.message || "Could not start a sync." });
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Google Search Console? New data will stop syncing. You can reconnect at any time.")) return;
    setBusy("disconnect");
    setBanner(null);
    try {
      const response = await fetch(`/api/customer/gsc?brand_key=${encodeURIComponent(brandKey)}`, { method: "DELETE" });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not disconnect Google Search Console.");
      trackEvent("gsc:disconnect", {});
      setCallback({ attempt: "", error: "" });
      stripCallbackParams();
      setBanner({ tone: "success", text: "Google Search Console is disconnected." });
      await refreshGsc();
    } catch (error) {
      setBanner({ tone: "error", text: error.message || "Could not disconnect Google Search Console." });
    } finally {
      setBusy("");
    }
  }

  function closePicker() {
    setCallback({ attempt: "", error: "" });
    stripCallbackParams();
    refreshGsc();
  }

  function handleConnected(property) {
    setCallback({ attempt: "", error: "" });
    stripCallbackParams();
    setBanner({ tone: "success", text: `Connected ${property?.siteUrl || "the selected property"}. The first sync is queued.` });
    refreshGsc();
  }

  function dismissCallbackError() {
    setCallback((current) => ({ ...(current || {}), error: "" }));
    stripCallbackParams();
  }

  const badge = gsc
    ? connected
      ? <Badge tone="good" dot>Connected</Badge>
      : <Badge dot>Not connected</Badge>
    : null;

  let content;
  if (!callback || !gsc) {
    content = (
      <Card title="Search Console" description="Loading your connection…">
        <SkeletonRows rows={3} />
      </Card>
    );
  } else if (gsc.error) {
    content = <Banner tone="error" title="Could not read your Search Console connection">{gsc.error}</Banner>;
  } else if (!isOwner) {
    content = connected ? (
      <>
        <ConnectionCard connection={connection} />
        <PerformanceCard brandKey={brandKey} syncKey={syncKey} redirectToLogin={redirectToLogin} />
      </>
    ) : (
      <Banner tone="info" title="Not connected">Ask a workspace owner to connect Search Console.</Banner>
    );
  } else if (!connected) {
    content = (
      <>
        {gsc.oauth_configured === false ? (
          <Banner tone="warn">Google Search Console is not configured on this deployment yet.</Banner>
        ) : null}
        {pickerOpen ? (
          <PropertyPicker
            brandKey={brandKey}
            attemptId={callback.attempt}
            website={brand?.website || ""}
            onConnected={handleConnected}
            onCancel={closePicker}
            onRestart={startConnect}
            redirectToLogin={redirectToLogin}
          />
        ) : (
          <ConnectCard
            onConnect={startConnect}
            busy={busy === "connect"}
            disabled={gsc.oauth_configured === false}
          />
        )}
      </>
    );
  } else {
    content = (
      <>
        {pickerOpen ? (
          <PropertyPicker
            brandKey={brandKey}
            attemptId={callback.attempt}
            website={brand?.website || ""}
            onConnected={handleConnected}
            onCancel={closePicker}
            onRestart={startConnect}
            redirectToLogin={redirectToLogin}
          />
        ) : null}
        <ConnectionCard
          connection={connection}
          owner
          busy={busy}
          onSync={syncNow}
          onChange={startConnect}
          onDisconnect={disconnect}
        />
        <PerformanceCard brandKey={brandKey} syncKey={syncKey} redirectToLogin={redirectToLogin} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Google Search Console"
        description="Connect your own Google account to bring search clicks and impressions into this workspace."
        actions={badge}
      />
      {callback?.error ? (
        <Banner tone="error" title="Search Console could not be connected" onDismiss={dismissCallbackError}>
          {callback.error}
        </Banner>
      ) : null}
      {banner ? (
        <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>
      ) : null}
      {content}
    </>
  );
}

function ConnectCard({ onConnect, busy, disabled }) {
  return (
    <Card className="text-center">
      <div className="mx-auto grid max-w-md justify-items-center gap-4 py-4">
        <div className="grid size-11 place-items-center rounded-xl border border-border bg-muted text-muted-foreground" aria-hidden="true">
          <Search className="size-5" />
        </div>
        <h2 className="text-lg font-semibold tracking-tight">Connect Google Search Console</h2>
        <p className="text-sm text-muted-foreground">This connection imports Search Analytics query data. Google’s separate Generative AI report is not imported here.</p>
        <ul className="grid w-full list-none gap-2.5 p-0 text-left text-sm text-muted-foreground">
          <li className="flex items-start gap-2.5"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />See which searches bring visitors to your site.</li>
          <li className="flex items-start gap-2.5"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />Compare Google Search queries with your separately collected AI observations.</li>
          <li className="flex items-start gap-2.5"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />Read-only access. Disconnect any time.</li>
        </ul>
        <Button icon={Link2} loading={busy} disabled={disabled} onClick={onConnect}>
          Connect with Google
        </Button>
      </div>
    </Card>
  );
}

function ConnectionCard({ connection, owner = false, busy = "", onSync, onChange, onDisconnect }) {
  const status = syncStatus(connection);
  return (
    <Card
      title="Connection"
      description={owner ? "The property this workspace reads search data from." : "Managed by a workspace owner."}
      footer={owner ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon={RefreshCw} loading={busy === "sync"} disabled={!!busy && busy !== "sync"} onClick={onSync}>
            Sync now
          </Button>
          <Button variant="secondary" size="sm" icon={Link2} disabled={!!busy} onClick={onChange}>
            Change property
          </Button>
          <span className="flex-1" />
          <Button variant="danger" size="sm" icon={Unplug} loading={busy === "disconnect"} disabled={!!busy && busy !== "disconnect"} onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      ) : null}
    >
      {connection?.last_status === "failed" ? (
        <Banner tone="error" title="The last sync failed">
          {connection.last_error || "Unknown error. Try syncing again."}
        </Banner>
      ) : null}
      <dl className="grid divide-y divide-border">
        <div className="grid gap-1 py-3 first:pt-0">
          <dt className="text-xs text-muted-foreground">Property</dt>
          <dd className="break-words font-mono text-[13.5px] text-foreground">{connection?.site_url || "—"}</dd>
        </div>
        <div className="grid gap-1 py-3">
          <dt className="text-xs text-muted-foreground">Data through</dt>
          <dd className="text-sm text-foreground">{formatDate(connection?.last_ingested_through)}</dd>
        </div>
        <div className="grid gap-1 py-3">
          <dt className="text-xs text-muted-foreground">Last sync</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone} dot>{status.label}</Badge>
            {connection?.last_attempt_at ? <span className="text-xs text-muted-foreground">{formatRelative(connection.last_attempt_at)}</span> : null}
          </dd>
        </div>
        {connection?.connected_at ? (
          <div className="grid gap-1 py-3 last:pb-0">
            <dt className="text-xs text-muted-foreground">Connected</dt>
            <dd className="text-sm text-foreground">{formatDate(connection.connected_at, { withTime: true })}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}
