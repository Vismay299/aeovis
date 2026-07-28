'use client';

/**
 * The cabin's control column.
 *
 * Identity at the head, the brand under observation in its berth, the panel
 * regions as engraved legend buttons with an indicator lamp each, and the
 * train register of previous readings below. Selection is shown by a lit
 * lamp and a lit legend — position and light, not colour alone.
 */

import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Wordmark } from './Wordmark';
import { Button } from './Button';
import { Describer } from '@/components/signal/Describer';
import { Lamp } from '@/components/signal/Lamp';

const NAV_ITEMS = [
  { key: 'overview', label: 'overview', testId: 'sidebar-overview' },
  { key: 'answers', label: 'answers', testId: 'sidebar-answers' },
  { key: 'rivals', label: 'rivals', testId: 'sidebar-rivals' },
  { key: 'sources', label: 'sources', testId: 'sidebar-sources' },
  { key: 'queries', label: 'queries', testId: 'sidebar-queries' },
  { key: 'crawlability', label: 'crawlability', testId: 'sidebar-crawlability' },
  { key: 'studio', label: 'studio', testId: 'sidebar-studio' },
];

function readingLamp(v) {
  if (v == null) return 'amber';
  if (v >= 50) return 'green';
  if (v >= 25) return 'amber';
  return 'red';
}

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
    <aside data-testid="sidebar" className="sb-cabin">
      <div className="sb-cabin__head">
        <a
          href="/"
          style={{ display: 'inline-flex' }}
          onClick={(e) => {
            e.preventDefault();
            router.push('/');
          }}
        >
          <Wordmark size="sm" />
        </a>
      </div>

      {brand && (
        <div className="sb-cabin__berth">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Lamp lamp={readingLamp(currentScore)} size={8} />
            <span className="sb-cabin__brand" title={brand}>
              {brand}
            </span>
            {currentScore != null && Number.isFinite(currentScore) && (
              <span style={{ marginLeft: 'auto' }}>
                <Describer
                  value={String(Math.round(currentScore)).padStart(2, '0')}
                  size={14}
                  bloom={false}
                  lamp={readingLamp(currentScore)}
                />
              </span>
            )}
          </div>
          {website && (
            <div className="t-stamp sb-cabin__site" title={website}>
              {website}
            </div>
          )}
        </div>
      )}

      <nav className="sb-cabin__nav" aria-label="Panel regions">
        <div className="sb-cabin__legends">
          {NAV_ITEMS.map((item) => {
            const isActive = view === item.key;
            return (
              <button
                key={item.key}
                type="button"
                data-testid={item.testId}
                className="sb-legend"
                data-active={isActive ? 'true' : 'false'}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onViewChange(item.key)}
              >
                <Lamp lamp="white" lit={isActive} size={7} />
                <span>{item.label}</span>
                {item.key === 'studio' && studioBadge > 0 && (
                  <span data-testid="sidebar-studio-badge" className="sb-legend__count">
                    {studioBadge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {history && history.length > 0 && (
          <div className="sb-cabin__register">
            <span className="t-plate" style={{ padding: '0 12px 8px', display: 'block' }}>
              register
            </span>
            <div className="sb-scroll" data-lenis-prevent style={{ maxHeight: 168 }}>
              {history.slice(0, 8).map((scan, i) => {
                const isActive =
                  activeScanTimestamp &&
                  new Date(scan.scanned_at).getTime() === new Date(activeScanTimestamp).getTime();
                return (
                  <button
                    key={i}
                    type="button"
                    className="sb-entry"
                    data-active={isActive ? 'true' : 'false'}
                    onClick={() => onHistoryClick?.(scan)}
                  >
                    <span className="sb-entry__time">
                      {new Date(scan.scanned_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    <span className="sb-entry__val t-tally">{scan.visibility_pct}%</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </nav>

      <div className="sb-cabin__foot">
        <Button
          variant="primary"
          size="md"
          style={{ width: '100%' }}
          onClick={onNewScan || (() => router.push('/scan'))}
        >
          <Plus size={13} />
          new scan
        </Button>
      </div>
    </aside>
  );
};

export default Sidebar;
