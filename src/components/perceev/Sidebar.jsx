'use client';

/**
 * The app sidebar.
 *
 * Real navigation, not a picture of navigation: the five product views live
 * inside one shell and this switches between them. Below 1080px it collapses
 * into a horizontal scroller and the groups and footer drop away.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus, LayoutDashboard, MessageSquareText, Users, Link2,
  ListChecks, Bot, Radar,
} from 'lucide-react';
import { Wordmark } from '@/components/landing/SiteNav';
/**
 * R2.1.1 — the readings list prints a stored scan's score, and that score is
 * now nullable (an engine that measured nothing publishes null, never 0). One
 * shared reader decides what a stored number means; see describeScanMeasurement.
 *
 * KNOWN COST, same one DashboardShell records at its own import of this module:
 * enginePipeline pulls the probe modules into the client bundle. Sidebar is
 * imported by DashboardShell and by nothing else (`git grep perceev/Sidebar`),
 * and DashboardShell already imports this module, so this adds no bundle weight
 * that was not already there — but it is the same debt and it moves with it.
 */
import { describeScanMeasurement } from '@/lib/scoring/enginePipeline';

const GROUPS = [
  {
    label: 'Reading',
    items: [
      { key: 'overview', label: 'Overview', icon: LayoutDashboard },
      { key: 'answers', label: 'Answers', icon: MessageSquareText },
      { key: 'rivals', label: 'Rivals', icon: Users },
      { key: 'sources', label: 'Sources', icon: Link2 },
    ],
  },
  {
    label: 'Operate',
    items: [
      { key: 'queries', label: 'Queries', icon: ListChecks },
      { key: 'crawlability', label: 'Crawlability', icon: Radar },
      { key: 'studio', label: 'Studio', icon: Bot },
    ],
  },
];

export const Sidebar = ({
  brand,
  website,
  view,
  onViewChange,
  history = [],
  onHistoryClick,
  activeScanTimestamp,
  onNewScan,
  studioBadge = 0,
  currentScore,
}) => {
  const router = useRouter();

  return (
    <aside data-testid="sidebar" className="side">
      <div className="side__brand">
        <Link href="/">
          <Wordmark />
        </Link>
      </div>

      {brand && (
        <div
          style={{
            padding: '10px 10px 12px', marginBottom: 6,
            borderBottom: '1px solid var(--line-soft)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <b
              title={brand}
              style={{
                fontSize: 14, fontWeight: 640, color: 'var(--ink-1)', letterSpacing: '-.015em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {brand}
            </b>
            {currentScore != null && Number.isFinite(currentScore) && (
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--brand)' }}>
                {Math.round(currentScore)}%
              </span>
            )}
          </div>
          {website && (
            <div
              className="tag"
              title={website}
              style={{ marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {website}
            </div>
          )}
        </div>
      )}

      <nav className="side__nav" aria-label="Views">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <div className="side__g tag">{g.label}</div>
            {g.items.map((item) => {
              const Icon = item.icon;
              const isActive = view === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`sidebar-${item.key}`}
                  className={`side__i${isActive ? ' is-on' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => onViewChange(item.key)}
                >
                  <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.key === 'studio' && studioBadge > 0 && (
                    <b data-testid="sidebar-studio-badge">{studioBadge}</b>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {history && history.length > 0 && (
        <div className="side__foot">
          <div className="tag" style={{ marginBottom: 8 }}>Readings</div>
          <div style={{ maxHeight: 168, overflowY: 'auto' }} data-lenis-prevent>
            {history.slice(0, 8).map((scan, i) => {
              const isActive = activeScanTimestamp
                && new Date(scan.scanned_at).getTime() === new Date(activeScanTimestamp).getTime();
              // `{scan.visibility_pct}%` printed a bare "%" on a null. The dash
              // and the percent sign both come from `text`, so an unmeasured
              // reading cannot render a stray unit.
              const score = describeScanMeasurement(scan);
              return (
                <button
                  key={i}
                  type="button"
                  className={`side__i${isActive ? ' is-on' : ''}`}
                  onClick={() => onHistoryClick?.(scan)}
                >
                  <span style={{ fontSize: 13 }}>
                    {new Date(scan.scanned_at).toLocaleDateString(undefined, {
                      month: 'short', day: 'numeric',
                    })}
                  </span>
                  {/*
                    The row is a fixed-height two-column button, so a state CHIP
                    does not fit here without redesigning the list; the state
                    rides as a title + aria-label instead, and the same words are
                    rendered as visible text on the dashboard's history cards
                    (DashboardShell "Previous readings"), which is the surface
                    that has room for them. Stated rather than implied: a
                    sighted user hovers to get the reason here.
                  */}
                  <b
                    data-testid="sidebar-history-score"
                    data-measured={score.measured ? 'true' : 'false'}
                    data-state-reason={score.reason || undefined}
                    title={score.detail || undefined}
                    aria-label={
                      score.measured
                        ? undefined
                        : `${score.label}: ${score.detail}`
                    }
                  >
                    {score.text}
                  </b>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="side__foot">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          style={{ width: '100%' }}
          onClick={onNewScan || (() => router.push('/scan'))}
        >
          <Plus size={14} aria-hidden="true" />
          New scan
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
