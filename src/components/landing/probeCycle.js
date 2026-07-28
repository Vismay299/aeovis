'use client';

/**
 * The demonstration running on the landing panel.
 *
 * DEMONSTRATION DATA. The questions are real category questions asked the
 * way the product asks them — unbranded, never leading. The brands are the
 * product's fictional stand-ins (Brightwave / NorthPeak / Lumen IQ) and are
 * labeled as synthetic wherever they appear. Nothing here is a customer
 * result, a benchmark, or a claim about accuracy.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/motion';

export const YOU = 'Brightwave';
export const PLATFORMS = [YOU, 'NorthPeak', 'Lumen IQ', null];

/** The tracked set shown as berths. Codes follow describer convention. */
export const TRACKED_SET = [
  { code: '1A01', q: 'best EHR platform for a 200-bed hospital', engine: 'ai overview', to: 'NorthPeak' },
  { code: '1A02', q: 'how do mid-size hospitals cut readmission rates', engine: 'perplexity', to: YOU },
  { code: '1A03', q: 'top patient engagement software in India', engine: 'ai overview', to: null },
  { code: '1A04', q: 'which analytics tools track clinical outcomes', engine: 'chatgpt', to: YOU },
  { code: '1A05', q: 'affordable HIMS for multi-specialty clinics', engine: 'perplexity', to: 'Lumen IQ' },
  { code: '1A06', q: 'vendors for hospital revenue cycle automation', engine: 'ai overview', to: 'NorthPeak' },
  { code: '1A07', q: 'how to reduce OT turnaround time', engine: 'chatgpt', to: null },
  { code: '1A08', q: 'teleconsultation platforms for tier-2 cities', engine: 'perplexity', to: YOU },
  { code: '1A09', q: 'NABH compliance software comparison', engine: 'ai overview', to: 'NorthPeak' },
  { code: '1A10', q: 'best way to benchmark clinical quality metrics', engine: 'chatgpt', to: 'Lumen IQ' },
  { code: '1A11', q: 'hospital inventory management best practices', engine: 'ai overview', to: null },
  { code: '1A12', q: 'patient no-show reduction tools', engine: 'perplexity', to: YOU },
];

export const SECTIONS = 7;

/**
 * One cycle: a question is called, illumination travels the route section by
 * section, the record takes the entry, and the next question arrives.
 */
export function useProbeCycle() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const [lit, setLit] = useState(0);
  const [record, setRecord] = useState([]);
  const timers = useRef([]);

  const probe = TRACKED_SET[step % TRACKED_SET.length];

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];

    const commit = () =>
      setRecord((prev) =>
        [{ code: probe.code, engine: probe.engine, to: probe.to }, ...prev].slice(0, 5),
      );

    if (reduced) {
      setLit(SECTIONS);
      commit();
      timers.current.push(setTimeout(() => setStep((s) => s + 1), 6000));
      return () => timers.current.forEach(clearTimeout);
    }

    setLit(0);
    for (let i = 1; i <= SECTIONS; i += 1) {
      timers.current.push(setTimeout(() => setLit(i), 280 + i * 100));
    }
    timers.current.push(setTimeout(commit, 280 + SECTIONS * 100 + 140));
    timers.current.push(setTimeout(() => setStep((s) => s + 1), 3600));

    return () => timers.current.forEach(clearTimeout);
  }, [step, reduced, probe.code, probe.engine, probe.to]);

  return { probe, lit, record, index: step % TRACKED_SET.length, reduced };
}
