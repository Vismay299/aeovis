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
import "./gsc.css";

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
    <div className="pv-page">
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
      <div className="pv-stack">{content}</div>
    </div>
  );
}

function ConnectCard({ onConnect, busy, disabled }) {
  return (
    <Card className="pv-gsc-connect">
      <div className="pv-gsc-connect__icon" aria-hidden="true">
        <Search />
      </div>
      <h2 className="pv-gsc-connect__title">Connect Google Search Console</h2>
      <ul className="pv-gsc-benefits">
        <li><CircleCheck aria-hidden="true" />See which searches bring visitors to your site.</li>
        <li><CircleCheck aria-hidden="true" />Compare search demand with how AI engines mention your brand.</li>
        <li><CircleCheck aria-hidden="true" />Read-only access. Disconnect any time.</li>
      </ul>
      <Button icon={Link2} loading={busy} disabled={disabled} onClick={onConnect}>
        Connect with Google
      </Button>
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
        <div className="pv-gsc-footer">
          <Button variant="secondary" size="sm" icon={RefreshCw} loading={busy === "sync"} disabled={!!busy && busy !== "sync"} onClick={onSync}>
            Sync now
          </Button>
          <Button variant="secondary" size="sm" icon={Link2} disabled={!!busy} onClick={onChange}>
            Change property
          </Button>
          <span className="pv-gsc-footer__spacer" />
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
      <dl className="pv-gsc-facts">
        <div>
          <dt>Property</dt>
          <dd className="pv-gsc-facts__mono">{connection?.site_url || "—"}</dd>
        </div>
        <div>
          <dt>Data through</dt>
          <dd>{formatDate(connection?.last_ingested_through)}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd className="pv-gsc-facts__status">
            <Badge tone={status.tone} dot>{status.label}</Badge>
            {connection?.last_attempt_at ? <span className="pv-muted">{formatRelative(connection.last_attempt_at)}</span> : null}
          </dd>
        </div>
        {connection?.connected_at ? (
          <div>
            <dt>Connected</dt>
            <dd>{formatDate(connection.connected_at, { withTime: true })}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}
