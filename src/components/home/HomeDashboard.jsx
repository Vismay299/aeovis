'use client';

/**
 * Trains already on the system.
 *
 * A slim rail across the head of the panel carrying the runs this operator
 * already has: each brand as a berth with its reading, each agent run as a
 * working entry. Renders nothing at all until there is history, so a
 * first-time visitor gets the clean panel.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { fetchScanHistory, saveScan } from '@/services/api';
import { Describer } from '@/components/signal/Describer';
import { Lamp } from '@/components/signal/Lamp';

function readingLamp(v) {
  if (v == null) return 'amber';
  if (v >= 50) return 'green';
  if (v >= 25) return 'amber';
  return 'red';
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
    if (!hasActive) return;
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
    <section data-testid="home-dashboard" className="lp-rail">
      <div className="lp-rail-inner">
        <span className="t-plate lp-rail-plate">on the system</span>

        <div className="lp-rail-items">
          {scans.map((s) => (
            <button
              key={s.brand}
              type="button"
              data-testid="home-brand-card"
              className="lp-rail-item"
              onClick={() => openBrand(s.brand)}
            >
              <Lamp lamp={readingLamp(s.score)} size={7} />
              <span className="lp-rail-name">{s.brand}</span>
              <Describer
                value={s.score == null ? '--' : String(Math.round(s.score)).padStart(2, '0')}
                size={12}
                bloom={false}
                lamp={readingLamp(s.score)}
              />
              <span className="lp-rail-meta">{timeAgo(s.scanned_at)}</span>
              {opening === s.brand && (
                <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
              )}
            </button>
          ))}

          {runs.slice(0, 3).map((r) => (
            <button
              key={r.id}
              type="button"
              data-testid="home-run-card"
              className="lp-rail-item"
              onClick={() => openRun(r)}
              title={`${r.agent_name} · ${r.brand}`}
            >
              <span aria-hidden="true" style={{ fontSize: 12 }}>
                {r.agent_emoji}
              </span>
              <span className="lp-rail-name">{r.title || '(untitled)'}</span>
              <span className="lp-rail-meta">{statusLabel[r.status] || 'draft'}</span>
            </button>
          ))}
        </div>

        <div className="lp-rail-actions">
          {activeJobs.length > 0 && (
            <span className="lp-rail-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
              {activeJobs.length} working
            </span>
          )}
          {counts.awaiting > 0 && scans[0] && (
            <button type="button" className="lp-link" onClick={() => openBrand(scans[0].brand, 'studio')}>
              {counts.awaiting} awaiting you
            </button>
          )}
          {scans[0] && (
            <button type="button" className="lp-link" onClick={() => openBrand(scans[0].brand, 'studio')}>
              open studio
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export default HomeDashboard;
