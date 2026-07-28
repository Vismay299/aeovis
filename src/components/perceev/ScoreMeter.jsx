/**
 * A run of track circuits. Kept for surfaces that want the bare rail
 * without a name or tally beside it; the full row lives in
 * components/signal/TrackCircuit.
 */

import { TrackCircuit } from '@/components/signal/TrackCircuit';

export const ScoreMeter = ({ segments = 32, value = 0, max = 100, lamp = 'green', className = '' }) => (
  <TrackCircuit
    value={value}
    max={max}
    sections={segments}
    lamp={lamp}
    height={7}
    className={className}
    label={`${Math.round(value)} of ${max}`}
  />
);

export default ScoreMeter;
