"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

function percentage(value) {
  return value != null && Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : "—";
}

function dateLabel(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function CustomerPortal() {
  const router = useRouter();
  const [brands, setBrands] = useState([]);
  const [brandKey, setBrandKey] = useState("");
  const [data, setData] = useState(null);
  const [gsc, setGsc] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [team, setTeam] = useState(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [scanning, setScanning] = useState(false);

  const brand = useMemo(() => brands.find((item) => item.brandKey === brandKey) || null, [brands, brandKey]);
  const isOwner = brand?.role === "owner";

  useEffect(() => {
    let live = true;
    async function loadMemberships() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        setError("Customer login is not configured on this deployment yet.");
        setBusy(false);
        setReady(true);
        return;
      }
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (!live) return;
      if (!user) {
        router.replace(`/login?next=${encodeURIComponent("/portal")}`);
        return;
      }
      setCurrentUserId(user.id);
      const { data: memberships, error: membershipError } = await supabase
        .from("customer_brand_memberships")
        .select("brand_key, role, customer_brands!inner(brand_key, display_name, website, is_active)")
        .eq("user_id", user.id)
        .eq("customer_brands.is_active", true)
        .order("brand_key");
      if (!live) return;
      if (membershipError) {
        setError("We could not load your workspace access. Please refresh the page.");
        setBusy(false);
        setReady(true);
        return;
      }
      const assigned = (memberships || []).map((row) => ({
        brandKey: row.brand_key,
        role: row.role,
        ...(Array.isArray(row.customer_brands) ? row.customer_brands[0] : row.customer_brands),
      }));
      setBrands(assigned);
      setBrandKey((current) => current || assigned[0]?.brandKey || "");
      setReady(true);
      if (!assigned.length) setBusy(false);
    }
    loadMemberships();
    return () => { live = false; };
  }, [router]);

  const loadBrandData = useCallback(async () => {
    if (!brandKey) return;
    setBusy(true);
    setError("");
    try {
      const encoded = encodeURIComponent(brandKey);
      const [overviewResponse, gscResponse] = await Promise.all([
        fetch(`/api/customer/overview?brand_key=${encoded}`, { cache: "no-store" }),
        fetch(`/api/customer/gsc?brand_key=${encoded}`, { cache: "no-store" }),
      ]);
      if (overviewResponse.status === 401 || gscResponse.status === 401) {
        router.replace(`/login?next=${encodeURIComponent("/portal")}`);
        return;
      }
      const [overview, gscStatus] = await Promise.all([overviewResponse.json(), gscResponse.json()]);
      if (!overviewResponse.ok) throw new Error(overview.error || "Could not load your workspace.");
      if (!gscResponse.ok) throw new Error(gscStatus.error || "Could not read your Search Console connection.");
      setData(overview);
      setGsc(gscStatus);
    } catch (loadError) {
      setError(loadError.message || "Could not load your workspace.");
    } finally {
      setBusy(false);
    }
  }, [brandKey, router]);

  async function loadTeam() {
    if (!brandKey || !isOwner) return;
    setTeamLoading(true);
    try {
      const response = await fetch(`/api/customer/team?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" });
      if (response.ok) setTeam(await response.json());
    } catch { /* non-critical */ }
    finally { setTeamLoading(false); }
  }

  async function inviteMember(event) {
    event.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const response = await fetch("/api/customer/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_key: brandKey, email: inviteEmail }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setInviteEmail("");
      await loadTeam();
    } catch (inviteError) {
      setError(inviteError.message || "Could not invite this person.");
    } finally { setInviting(false); }
  }

  async function removeMember(userId) {
    try {
      const response = await fetch("/api/customer/team", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_key: brandKey, user_id: userId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await loadTeam();
    } catch (removeError) {
      setError(removeError.message || "Could not remove this member.");
    }
  }

  useEffect(() => {
    if (ready && brandKey) {
      loadBrandData();
      if (isOwner) loadTeam();
    }
  }, [ready, brandKey, isOwner, loadBrandData]);

  async function startGscConnect() {
    if (!brandKey) return;
    try {
      const response = await fetch("/api/customer/gsc/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_key: brandKey }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.authorization_url) {
        window.location.href = result.authorization_url;
      }
    } catch (connectError) {
      setError(connectError.message || "Could not start Google Search Console connection.");
    }
  }

  async function startScan() {
    if (!brandKey) return;
    setScanning(true);
    setError("");
    try {
      const response = await fetch("/api/customer/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_key: brandKey }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      // Refresh the data to show the new job.
      await loadBrandData();
    } catch (scanError) {
      setError(scanError.message || "Could not start the scan.");
    } finally { setScanning(false); }
  }

  async function signOut() {
    await getSupabaseBrowserClient()?.auth.signOut();
    router.replace("/login");
  }

  if (!ready && busy) {
    return <main className="customer-portal-page"><p className="customer-portal-state">Loading your workspace…</p></main>;
  }

  return (
    <main className="customer-portal-page">
      <header className="customer-portal-header">
        <Link href="/" className="customer-auth-brand">perceev</Link>
        <div className="customer-portal-header-actions">
          {brands.length > 1 ? (
            <label className="customer-brand-picker">
              <span className="sr-only">Choose brand</span>
              <select value={brandKey} onChange={(event) => setBrandKey(event.target.value)}>
                {brands.map((item) => <option key={item.brandKey} value={item.brandKey}>{item.display_name}</option>)}
              </select>
            </label>
          ) : brand ? <span className="customer-portal-brand-label">{brand.display_name}</span> : null}
          <button className="customer-auth-link" type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {!brands.length ? (
        <section className="customer-portal-empty">
          <p className="customer-auth-kicker">WORKSPACE SETUP</p>
          <h1>{error ? "Workspace unavailable." : "Your account is ready."}</h1>
          <p>{error || "Verify your work email, add Perceev’s Search Console account to your brand property, and finish setting up your workspace."}</p>
          {!error ? <Link href="/onboarding" className="btn btn--primary">Set up my workspace</Link> : null}
        </section>
      ) : (
        <div className="customer-portal-content">
          <div className="customer-portal-heading">
            <div>
              <p className="customer-auth-kicker">CUSTOMER WORKSPACE</p>
              <h1>{brand?.display_name || "Your brand"}</h1>
              {brand?.website ? <a href={brand.website} target="_blank" rel="noreferrer">{brand.website}</a> : null}
            </div>
            <span className="customer-portal-status"><i /> UAT workspace</span>
          </div>

          {error ? <p className="customer-portal-alert" role="alert">{error}</p> : null}
          {busy ? <p className="customer-portal-state">Loading your brand data…</p> : null}

          <section className="customer-portal-metrics" aria-label="Latest scan summary">
            <article className="customer-portal-card customer-portal-score">
              <span>Latest visibility</span>
              <strong>{percentage(data?.latest_scan?.visibility_pct)}</strong>
              <small>{data?.latest_scan ? `Scan from ${dateLabel(data.latest_scan.scanned_at || data.latest_scan.created_at)}` : "No completed scan yet"}</small>
            </article>
            <article className="customer-portal-card">
              <span>Tracked questions</span>
              <strong>{data?.latest_scan?.prompts_tracked ?? "—"}</strong>
              <small>In the latest completed scan</small>
            </article>
            <article className="customer-portal-card">
              <span>Search Console</span>
              <strong className={gsc?.connected ? "customer-good" : "customer-muted"}>{gsc?.connected ? "Connected" : "Not connected"}</strong>
              <small>{gsc?.connection?.site_url || "Connect a property below"}</small>
            </article>
          </section>

          <div style={{ marginBottom: "1rem" }}>
            <button className="btn btn--primary" onClick={startScan} disabled={scanning}>{scanning ? "Starting scan…" : "Start AI visibility scan"}</button>
          </div>

          <div className="customer-portal-columns">
            <section className="customer-portal-panel">
              <div className="customer-portal-panel-heading"><h2>Scans</h2><span>{data?.scans?.length || 0}</span></div>
              {data?.scan_jobs?.length ? (
                <div className="customer-portal-list">
                  {data.scan_jobs.filter((j) => ["pending", "generating_prompts", "probing", "scoring"].includes(j.status)).map((job) => (
                    <article key={job.id} className="customer-portal-list-row">
                      <div><strong>Scan in progress</strong><small>{job.status} · {job.progress_pct || 0}%</small></div>
                      <b className="customer-portal-pill">{job.status}</b>
                    </article>
                  ))}
                </div>
              ) : null}
              {data?.scans?.length ? (
                <div className="customer-portal-list">
                  {data.scans.map((scan) => (
                    <article key={scan.id} className="customer-portal-list-row">
                      <div><strong>{dateLabel(scan.scanned_at || scan.created_at)}</strong><small>{scan.prompts_tracked ?? "—"} questions · {scan.platform || "AI visibility"}</small></div>
                      <b>{percentage(scan.visibility_pct)}</b>
                    </article>
                  ))}
                </div>
              ) : <p className="customer-portal-empty-copy">No scans are available for this workspace yet.</p>}
            </section>

            <section className="customer-portal-panel">
              <div className="customer-portal-panel-heading"><h2>Content Studio</h2><span>{data?.content_items?.length || 0}</span></div>
              {data?.content_items?.length ? (
                <div className="customer-portal-list">
                  {data.content_items.map((item) => (
                    <article key={item.id} className="customer-portal-list-row">
                      <div><strong>{item.title || "Untitled draft"}</strong><small>Updated {dateLabel(item.updated_at || item.created_at)}</small></div>
                      <b className="customer-portal-pill">{item.status || "draft"}</b>
                    </article>
                  ))}
                </div>
              ) : <p className="customer-portal-empty-copy">No content drafts are available yet.</p>}
            </section>
          </div>

          <section className="customer-portal-panel customer-portal-gsc">
            <div className="customer-portal-panel-heading">
              <div><h2>Google Search Console</h2><p>Connect your own Google account to import search data for this workspace.</p></div>
              <span className={gsc?.connected ? "customer-gsc-badge is-connected" : "customer-gsc-badge"}>{gsc?.connected ? "Connected" : "Not connected"}</span>
            </div>
            {gsc?.connected ? (
              <div className="customer-gsc-status">
                <p>Property: <strong>{gsc.connection?.site_url || "—"}</strong></p>
                {gsc.connection?.last_ingested_through ? <p>Data through: {dateLabel(gsc.connection.last_ingested_through)}</p> : null}
                {gsc.connection?.last_status === "failed" ? <p className="customer-portal-alert">Last sync failed: {gsc.connection?.last_error || "Unknown error"}. Retry from your workspace.</p> : null}
                {isOwner ? (
                  <div className="customer-gsc-actions">
                    <button className="btn btn--secondary" type="button" onClick={startGscConnect}>Reconnect</button>
                    <button className="btn btn--ghost" type="button" onClick={async () => {
                      await fetch(`/api/customer/gsc?brand_key=${encodeURIComponent(brandKey)}`, { method: "DELETE" });
                      await loadBrandData();
                    }}>Disconnect</button>
                  </div>
                ) : null}
              </div>
            ) : isOwner ? (
              <div>
                <p className="customer-gsc-instruction">Click below to authorize your Google account. You&apos;ll choose which Search Console property to connect.</p>
                <button className="btn btn--primary" type="button" onClick={startGscConnect}>Connect Google Search Console</button>
              </div>
            ) : (
              <p className="customer-muted">Ask a workspace owner to connect Google Search Console.</p>
            )}
          </section>

          {isOwner ? (
            <section className="customer-portal-panel customer-portal-team">
              <div className="customer-portal-panel-heading">
                <h2>Team</h2>
                <span>{(team?.members?.length || 0)} member{(team?.members?.length || 0) !== 1 ? "s" : ""}</span>
              </div>
              {teamLoading ? <p className="customer-portal-state">Loading team…</p> : null}
              {team?.members?.length ? (
                <div className="customer-portal-list">
                  {team.members.map((m) => (
                    <article key={m.user_id} className="customer-portal-list-row">
                      <div>
                        <strong>{m.email || "Unknown"}</strong>
                        <small>{m.role}{m.user_id === currentUserId ? " (you)" : ""}</small>
                      </div>
                      {m.user_id !== currentUserId ? (
                        <button className="btn btn--ghost btn--sm" type="button" onClick={() => removeMember(m.user_id)}>Remove</button>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : null}
              {team?.pending_invites?.length ? (
                <div className="customer-portal-list" style={{ marginTop: "0.5rem" }}>
                  {team.pending_invites.map((inv) => (
                    <article key={inv.id} className="customer-portal-list-row customer-muted">
                      <div><strong>{inv.email}</strong><small>Invite pending · {inv.role}</small></div>
                    </article>
                  ))}
                </div>
              ) : null}
              <form className="customer-gsc-form" onSubmit={inviteMember} style={{ marginTop: "1rem" }}>
                <label htmlFor="invite-email">Invite a team member</label>
                <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@company.com" required />
                <button className="btn btn--primary" disabled={inviting || !inviteEmail.trim()} type="submit">{inviting ? "Inviting…" : "Send invite"}</button>
              </form>
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
