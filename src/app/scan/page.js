'use client';

/**
 * Scan.
 *
 * Three states in one screen: entry → running → complete. Entry asks for the
 * least it can and starts; running reports what the job actually says about
 * itself; complete hands over to the reading.
 *
 * The running state deliberately shows real progress only. The landing page's
 * ribbon diagram resolves questions to named brands, and the scan job reports
 * a stage and a percentage — not per-question verdicts — so drawing brands
 * here would be inventing telemetry the product does not have yet.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Wordmark } from '@/components/landing/SiteNav';
import { runScan, saveScan, fetchIndustries, loadScan, clearScan } from '@/shared/api';
import {
  initialScanProgress,
  beginScanProgress,
  applyScanReading,
  applyScanUnknown,
  isReconnecting,
  progressLabel,
  progressFraction,
} from '@/shared/scanProgress';
import { SAMPLE_RESULT } from '@/shared/mockData';
import { scanCompletionNotice } from '@/shared/scanCompletion';

const STAGES = [
  { label: 'Brand accepted', detail: 'the domain is resolved and the run is queued' },
  { label: 'Questions sourced', detail: 'real buyer queries, none of which name you' },
  { label: 'Engines probed', detail: 'every question put to every engine in turn' },
  { label: 'Answers scored', detail: 'verdicts recorded, evidence kept verbatim' },
];

/* The sample report, quoting the one demonstration reading. Brightwave is
   fictional, and the page says so.

   R2.10.1 — these three were typed: '41%', '15 / 36', '7'. The report they
   preview moved to 30 questions and a 13-answer win, so this panel advertised a
   reading that no longer existed anywhere. Read off SAMPLE_RESULT now; it is
   the same object the button below hands to the dashboard. */
const SAMPLE_FACTS = [
  { k: 'Share of AI', v: `${SAMPLE_RESULT.visibilityScore}%` },
  {
    k: 'Answers naming you',
    v: `${SAMPLE_RESULT.results.filter((r) => r.visible).length} / ${SAMPLE_RESULT.promptsTracked}`,
  },
  { k: 'Rivals discovered', v: String(SAMPLE_RESULT.competitorsFound) },
];

export default function Scan() {
  const router = useRouter();
  const [brand, setBrand] = useState('');
  const [website, setWebsite] = useState('');
  const [industry, setIndustry] = useState('');
  const [customIndustry, setCustomIndustry] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [industries, setIndustries] = useState([]);
  const [errors, setErrors] = useState({});

  const [scanning, setScanning] = useState(false);
  /* Stage, progress and connection move together — a poll that reports nothing
     must not be able to rewind one of them behind the others. See
     lib/scanProgress.js (R2.8.3 / finding A11). */
  const [progressState, setProgressState] = useState(initialScanProgress);
  const [failed, setFailed] = useState(false);

  const stage = progressState.stage;
  const label = progressLabel(progressState);
  const reconnecting = isReconnecting(progressState);

  useEffect(() => {
    fetchIndustries()
      .then((data) => setIndustries(data.industries || []))
      .catch(() => {
        /* the industry hint is optional; the scan runs without it */
      });
  }, []);

  /* A domain typed on the landing page arrives here already set. */
  useEffect(() => {
    try {
      const pre = localStorage.getItem('perceev_prescan_domain');
      if (pre) {
        setWebsite(pre);
        localStorage.removeItem('perceev_prescan_domain');
      }
    } catch {
      /* nothing was stored — the field simply starts empty */
    }
  }, []);

  const validate = () => {
    const e = {};
    if (!brand.trim()) e.brand = 'Enter the brand name so we know what to look for.';
    if (!website.trim()) e.website = 'Enter the domain you want probed.';
    else if (!/^([\w-]+\.)+[\w-]{2,}.*$/.test(website.replace(/^https?:\/\//, '')))
      e.website = 'That does not look like a domain. Try acme.com';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const start = async (ev) => {
    if (ev) ev.preventDefault();
    if (!validate()) return;

    try {
      const current = loadScan();
      const newBrand = brand.trim();
      const newWebsite = website.trim();
      if (current && (current.brand !== newBrand || current.website !== newWebsite)) {
        clearScan();
      }
    } catch {
      /* no readable prior scan — nothing to clear */
    }

    setScanning(true);
    setFailed(false);
    setProgressState(beginScanProgress());
    try {
      const result = await runScan(
        {
          brand: brand.trim(),
          website: website.trim(),
          industry: industry === '__custom__' ? customIndustry.trim() : industry,
          competitors: competitors.trim(),
        },
        /* A reading. `p` may be null — that is "not measured yet", not zero,
           so the reducer keeps the last known figure instead of inventing one
           from the stage number. */
        (s, p) => setProgressState((prev) => applyScanReading(prev, { stage: s, progressPct: p })),
        /* A tick that produced no reading. The bar holds where it was and the
           page says "reconnecting" rather than pretending to be at 0%. */
        (meta) => setProgressState((prev) => applyScanUnknown(prev, meta)),
      );
      saveScan(result);
      const completion = scanCompletionNotice(result);
      const notify = completion.tone === 'success' ? toast.success : completion.tone === 'error' ? toast.error : completion.tone === 'warn' ? toast.warning : toast.info;
      notify(completion.title, { description: completion.message });
      router.push('/dashboard');
    } catch (err) {
      setFailed(true);
      setScanning(false);
      toast.error(err?.message || 'The scan could not complete. Try again.');
    }
  };

  const openSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push('/dashboard');
  };

  return (
    <>
      <header className="nav">
        <div className="shell nav__in">
          <Link href="/" aria-label="Perceev home"><Wordmark /></Link>
          <span className="tag" style={{ marginLeft: 4 }}>
            {scanning ? 'Probe running' : 'New probe'}
          </span>
          <div className="nav__r">
          </div>
        </div>
      </header>

      <div className="scan">
        <div className="scan__in">
          {/* ── entry ──────────────────────────────────────────────── */}
          <div className={`state${scanning ? '' : ' is-on'}`}>
            <span className="tag tag--brand">Free · no signup</span>
            <h2>Ask the engines about your brand.</h2>
            <p className="lede scan__sub">
              We put unbranded buyer questions to every answer engine and report which brand each
              answer recommends — including how often that brand is you.
            </p>

            <form
              onSubmit={start}
              className="stack" style={{ textAlign: 'left', marginTop: 32 }}
            >
              <div className="grid g2" style={{ gap: 16 }}>
                <div>
                  <label className="lbl" htmlFor="brand">Brand or company name</label>
                  <input
                    id="brand"
                    className="inp"
                    data-testid="scan-brand-input"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Acme Analytics"
                    aria-invalid={errors.brand ? 'true' : undefined}
                    aria-describedby={errors.brand ? 'brand-err' : undefined}
                  />
                  {errors.brand && (
                    <p id="brand-err" style={{ color: 'var(--crit)', fontSize: 13, marginTop: 6 }}>
                      {errors.brand}
                    </p>
                  )}
                </div>

                <div>
                  <label className="lbl" htmlFor="website">Website</label>
                  <input
                    id="website"
                    className="inp"
                    data-testid="scan-website-input"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="acme.com"
                    autoComplete="url"
                    spellCheck="false"
                    aria-invalid={errors.website ? 'true' : undefined}
                    aria-describedby={errors.website ? 'website-err' : undefined}
                  />
                  {errors.website && (
                    <p id="website-err" style={{ color: 'var(--crit)', fontSize: 13, marginTop: 6 }}>
                      {errors.website}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="lbl" htmlFor="industry">Industry — optional</label>
                <select
                  id="industry"
                  className="inp"
                  data-testid="scan-industry-input"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                >
                  <option value="">Select an industry…</option>
                  {industries.map((ind) => (
                    <option key={ind.id} value={ind.id}>{ind.label}</option>
                  ))}
                  <option value="__custom__">Other — type your own…</option>
                </select>
                <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6 }}>
                  Used only if we cannot source enough real queries.
                </p>
              </div>

              {industry === '__custom__' && (
                <div>
                  <label className="lbl" htmlFor="custom-industry">Your industry</label>
                  <input
                    id="custom-industry"
                    className="inp"
                    data-testid="scan-custom-industry-input"
                    value={customIndustry}
                    onChange={(e) => setCustomIndustry(e.target.value)}
                    placeholder="e.g. Dental equipment, Pet food, Drone services"
                  />
                </div>
              )}

              <div>
                <label className="lbl" htmlFor="competitors">Rivals to track — optional</label>
                <input
                  id="competitors"
                  className="inp"
                  data-testid="scan-competitors-input"
                  value={competitors}
                  onChange={(e) => setCompetitors(e.target.value)}
                  placeholder="e.g. NorthPeak, Lumen IQ"
                />
                <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6 }}>
                  We also discover rivals from the answers themselves, so this only adds to them.
                </p>
              </div>

              <button
                className="btn btn--primary btn--lg"
                type="submit"
                data-testid="scan-submit-btn"
                style={{ width: '100%' }}
              >
                Run the probe
              </button>
            </form>

            <div style={{ marginTop: 44, textAlign: 'left' }}>
              <span className="tag">Not ready to run one?</span>
              <button
                type="button"
                data-testid="recent-scan-0"
                className="panel"
                onClick={openSample}
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer', marginTop: 12, padding: 0 }}
              >
                <div className="panel__h">
                  <b>Open the sample report</b>
                  <span className="chip">Brightwave · healthcare · India</span>
                  <span className="tag" style={{ marginLeft: 'auto' }}>Fictional brand</span>
                </div>
                <div className="panel__b">
                  <div className="grid g3">
                    {SAMPLE_FACTS.map((f) => (
                      <div key={f.k}>
                        <div className="stat__k">{f.k}</div>
                        <div className="stat__v" style={{ fontSize: 26 }}>{f.v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* ── running ────────────────────────────────────────────── */}
          <div className={`state${scanning ? ' is-on' : ''}`} data-testid={scanning ? 'scan-loading' : undefined}>
            <span className="tag tag--brand">Probe running</span>
            <h2>Asking the engines about {brand || 'your brand'}.</h2>
            <p className="lede scan__sub">
              Every tracked question goes to each engine in turn. A run that is interrupted picks up
              where it stopped, so this can safely take a few minutes.
            </p>

            <div className="probe">
              <div
                className="probe__bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={label.known ? progressState.progress : undefined}
                aria-valuetext={label.known ? label.text : 'Progress not known yet'}
                data-progress-state={label.known ? 'known' : 'unknown'}
              >
                <i style={{ transform: `scaleX(${progressFraction(progressState)})` }} />
              </div>
              <div className="probe__meta">
                {/* An em dash, never "0%", when there is no measurement — and a
                    chip that names the state (finding A11). */}
                <span className="tag" data-testid="scan-progress">{label.text}</span>
                {label.chip && (
                  <span
                    className="chip"
                    data-testid="scan-progress-state"
                    data-state={reconnecting ? 'reconnecting' : 'unmeasured'}
                  >
                    <i className="chip__led" />
                    {reconnecting ? 'Reconnecting…' : label.chip}
                  </span>
                )}
                <span className="tag">
                  {stage >= 0 && stage < STAGES.length ? STAGES[stage].label : 'Finishing'}
                </span>
              </div>

              <div className="panel" style={{ marginTop: 22 }}>
                <div className="panel__h"><b>Stages</b></div>
                <div className="panel__b">
                  <div className="stages">
                    {STAGES.map((s, i) => {
                      const done = i < stage;
                      const now = i === stage;
                      return (
                        <div
                          key={s.label}
                          className={`stage${done ? ' done' : ''}${now ? ' now' : ''}`}
                          data-testid={`scan-stage-${i}`}
                        >
                          <span className="stage__d" aria-hidden="true">
                            {done ? '✓' : i + 1}
                          </span>
                          <span>
                            <h4>{s.label}</h4>
                            <p>{s.detail}</p>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {failed && (
            <div
              className="panel"
              data-testid="scan-error-banner"
              style={{ marginTop: 24, textAlign: 'left', borderColor: 'var(--crit)' }}
            >
              <div className="panel__h">
                <span className="chip chip--crit"><i className="chip__led" /> Failed</span>
                <b>The scan could not complete</b>
              </div>
              <div className="panel__b">
                <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>
                  Nothing was saved, so you can run it again without losing anything.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
