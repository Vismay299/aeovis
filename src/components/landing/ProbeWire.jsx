'use client';

/**
 * The wire.
 *
 * Signal boxes are connected by a block circuit: a continuous run of route
 * records passing between cabins. This is that circuit — describer codes and
 * where each route was cleared to, running under the panel. Synthetic
 * demonstration fragments; the brands are the product's fictional stand-ins.
 */

import { Describer } from '@/components/signal/Describer';

const YOU = 'Brightwave';

const RECORDS = [
  { code: '1A01', engine: 'ai overview', to: 'NorthPeak' },
  { code: '1A02', engine: 'perplexity', to: YOU },
  { code: '1A03', engine: 'ai overview', to: null },
  { code: '1A04', engine: 'chatgpt', to: YOU },
  { code: '1A05', engine: 'perplexity', to: 'Lumen IQ' },
  { code: '1A06', engine: 'ai overview', to: 'NorthPeak' },
  { code: '1A07', engine: 'chatgpt', to: null },
  { code: '1A08', engine: 'perplexity', to: YOU },
];

const Record = ({ r }) => {
  const kind = r.to === YOU ? 'you' : r.to === null ? 'none' : 'rival';
  return (
    <span className="lp-wire-item">
      <Describer value={r.code} lamp={kind === 'you' ? 'white' : kind === 'none' ? 'amber' : 'red'} size={13} bloom={false} />
      <span className="lp-wire-engine">{r.engine}</span>
      <span className="lp-wire-arrow" aria-hidden="true">
        ▸
      </span>
      <span className="lp-wire-to" data-kind={kind}>
        {r.to === null ? 'no route set' : `cleared to ${r.to}`}
      </span>
    </span>
  );
};

export const ProbeWire = () => (
  <div className="lp-wire" aria-hidden="true">
    <span className="lp-wire-tab t-plate">block circuit</span>
    <div className="lp-wire-viewport">
      <div className="lp-wire-track">
        {[0, 1].map((copy) => (
          <span key={copy} className="lp-wire-group">
            {RECORDS.map((r, i) => (
              <Record key={`${copy}-${i}`} r={r} />
            ))}
          </span>
        ))}
      </div>
    </div>
  </div>
);

export default ProbeWire;
