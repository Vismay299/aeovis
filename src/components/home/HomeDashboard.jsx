'use client';

/**
 * What this operator already has running.
 *
 * A slim strip above the page carrying every brand already read and every
 * agent run in flight. Renders nothing at all until there is history, so a
 * first-time visitor gets the clean page.
 *
 * R2.8.16 — WHY THE `store` FIELD IS READ AND `scans.length` IS NOT. The clean
 * page above is a claim: "you have never scanned anything". It is only true when
 * /api/history actually reached the store. This component used to keep whatever
 * `res.ok` gave it and then decide on `scans.length === 0`, while the route
 * answered every refusal with 200 and empty arrays — so an unreadable database
 * rendered as a pristine first run to an operator with brands in it, with no
 * error anywhere on screen. The route now says which (`store: "ok"` vs
 * `"unreachable"`, 503 and null collections), and the outage branch below is the
 * half that makes that visible. Do not collapse it back into `data?.scans || []`.
 *
 * STATED PLAINLY, BECAUSE IT CHANGES WHAT THIS FIX IS WORTH TODAY: as of
 * R2.8.16 this component is not mounted on any page (`git grep HomeDashboard`
 * finds no importer) and it is the only caller of /api/history. So the change
 * above is not currently visible to a user — it is the honest shape waiting for
 * whoever mounts the strip, and the route's 503 is what a direct caller and any
 * future surface will see. Mounting it is a separate task; do not read this
 * paragraph as a claim that a live screen was repaired.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { fetchScanHistory, saveScan } from '@/services/api';
import { hasTimestamp } from '@/utils/format';
import { historyLoadState } from '@/lib/historyStoreState';

/* The reading's own band. Rivals never take a semantic colour, but this is
   your own score against a threshold, which is exactly what they are for. */
function scoreChip(v) {
  if (v == null || !Number.isFinite(v)) return 'chip';
  if (v >= 50) return 'chip chip--good';
  if (v >= 25) return 'chip chip--warn';
  return 'chip chip--crit';
}

function timeAgo(iso) {
  // R2.7.3 (finding C1) — a reading with no collection time renders an em dash,
  // not an empty string and never "just now". Unparseable counts as missing:
  // without this the NaN fell through the ladder and printed "NaNd ago".
  if (!hasTimestamp(iso)) return '—';
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const statusLabel = {
  awaiting_approval: 'awaiting you',
  approved: 'approved',
  rejected: 'rejected',
  changes_requested: 'in revision',
  draft: 'draft',
};

const itemStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 9,
  height: 34,
  padding: '0 12px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--ink-2)',
  fontSize: 13.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export function HomeDashboard({ initialData = null } = {}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [outage, setOutage] = useState(null);
  const [opening, setOpening] = useState(null);

  const load = useCallback(async () => {
    let next;
    try {
      const res = await fetch('/api/history', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      next = historyLoadState({ ok: res.ok, status: res.status, body });
    } catch {
      // The request never completed, so nothing was measured. Saying so is the
      // whole point; "best-effort" here used to mean "silent".
      next = historyLoadState(null);
    }
    setData(next.data);
    setOutage(next.outage);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (initialData) return;
    load();
  }, [load, initialData]);

  const hasActive = (data?.activeJobs || []).length > 0;
  useEffect(() => {
    if (!hasActive) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const openBrand = async (brand, view) => {
    setOpening(brand + (view || ''));
    try {
      const scans = await fetchScanHistory(brand);
      if (scans && scans[0]) saveScan(scans[0]);
      router.push(view ? `/dashboard?view=${view}` : '/dashboard');
    } catch {
      router.push('/dashboard');
    }
  };

  const openRun = async (run) => {
    setOpening(run.id);
    try {
      const scans = await fetchScanHistory(run.brand);
      if (scans && scans[0]) saveScan(scans[0]);
      router.push(`/dashboard?view=studio&item=${run.id}`);
    } catch {
      router.push('/dashboard?view=studio');
    }
  };

  if (loading) return null;

  // The unreachable store. Deliberately states no count, no score and no
  // "nothing yet" — every number this strip could print would have been
  // fabricated from a read that did not happen.
  if (outage) {
    return (
      <section
        data-testid="home-dashboard-unavailable"
        style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}
      >
        <div
          className="shell"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            paddingBlock: 12, minWidth: 0,
          }}
        >
          <span className="chip chip--crit" data-testid="home-history-unavailable-chip">
            History unavailable
          </span>
          <span style={{ color: 'var(--ink-2)', fontSize: 13.5, minWidth: 0 }}>
            Your workspace could not be read, so nothing is shown here — this is not
            an empty workspace.
          </span>
          <span className="tag" style={{ letterSpacing: '.06em' }}>{outage.reason}</span>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => { setLoading(true); load(); }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const scans = data?.scans || [];
  const runs = data?.runs || [];
  const activeJobs = data?.activeJobs || [];
  const counts = data?.counts || {};

  if (scans.length === 0 && runs.length === 0) return null;

  return (
    <section
      data-testid="home-dashboard"
      style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}
    >
      <div
        className="shell"
        style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          paddingBlock: 12, minWidth: 0,
        }}
      >
        <span className="tag">Already running</span>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0, flex: '1 1 320px' }}>
          {scans.map((s) => (
            <button
              key={s.brand}
              type="button"
              data-testid="home-brand-card"
              style={itemStyle}
              onClick={() => openBrand(s.brand)}
            >
              <b style={{ color: 'var(--ink-1)', fontWeight: 600 }}>{s.brand}</b>
              <span className={scoreChip(s.score)}>
                {s.score == null || !Number.isFinite(s.score) ? '—' : `${Math.round(s.score)}%`}
              </span>
              <span className="tag" style={{ letterSpacing: '.06em' }}>{timeAgo(s.scanned_at)}</span>
              {opening === s.brand && <Loader2 size={12} aria-hidden="true" />}
            </button>
          ))}

          {runs.slice(0, 3).map((r) => (
            <button
              key={r.id}
              type="button"
              data-testid="home-run-card"
              style={itemStyle}
              onClick={() => openRun(r)}
              title={`${r.agent_name} · ${r.brand}`}
            >
              <span aria-hidden="true">{r.agent_emoji}</span>
              <span
                style={{
                  color: 'var(--ink-1)', maxWidth: '22ch',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {r.title || '(untitled)'}
              </span>
              <span className="tag" style={{ letterSpacing: '.06em' }}>
                {statusLabel[r.status] || 'draft'}
              </span>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          {activeJobs.length > 0 && (
            <span className="chip chip--you">
              <Loader2 size={11} aria-hidden="true" /> {activeJobs.length} working
            </span>
          )}
          {counts.awaiting > 0 && scans[0] && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => openBrand(scans[0].brand, 'studio')}
            >
              {counts.awaiting} awaiting you
            </button>
          )}
          {scans[0] && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => openBrand(scans[0].brand, 'studio')}
            >
              Open Studio
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export default HomeDashboard;
