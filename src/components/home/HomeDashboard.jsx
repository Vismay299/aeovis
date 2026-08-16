'use client';

/**
 * What this operator already has running.
 *
 * A slim strip above the page carrying every brand already read and every
 * agent run in flight. Renders nothing at all until there is history, so a
 * first-time visitor gets the clean page.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { fetchScanHistory, saveScan } from '@/services/api';

/* The reading's own band. Rivals never take a semantic colour, but this is
   your own score against a threshold, which is exactly what they are for. */
function scoreChip(v) {
  if (v == null) return 'chip';
  if (v >= 50) return 'chip chip--good';
  if (v >= 25) return 'chip chip--warn';
  return 'chip chip--crit';
}

function timeAgo(iso) {
  if (!iso) return '';
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

export function HomeDashboard() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/history', { cache: 'no-store' });
      if (res.ok) setData(await res.json());
    } catch {
      /* homepage history is best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
                {s.score == null ? '—' : `${Math.round(s.score)}%`}
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
