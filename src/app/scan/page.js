'use client';

/**
 * Setting the route.
 *
 * Entering a brand is pressing the entrance button; the scan is the box
 * proving the route section by section before it clears. The stage list is
 * therefore a run of track circuits, not a spinner with steps beside it.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Wordmark } from '@/components/perceev/Wordmark';
import { Button } from '@/components/perceev/Button';
import { Input } from '@/components/perceev/Input';
import { Select } from '@/components/perceev/Select';
import { Alert } from '@/components/perceev/Alert';
import { Describer } from '@/components/signal/Describer';
import { Lamp } from '@/components/signal/Lamp';
import { TrackCircuit } from '@/components/signal/TrackCircuit';
import { runScan, saveScan, fetchIndustries, loadScan, clearScan } from '@/services/api';
import { SAMPLE_RESULT } from '@/data/mockData';

const STAGES = [
  { label: 'Brand accepted', detail: 'the entrance button is pressed' },
  { label: 'Questions sourced', detail: 'real buyer queries, unbranded' },
  { label: 'Engines probed', detail: 'every question put to every engine' },
  { label: 'Route proved', detail: 'answers scored, evidence composed' },
];

const RECENT = [
  { brand: 'Brightwave', site: 'brightwave.io', score: 71 },
  { brand: 'NorthPeak', site: 'northpeak.com', score: 52 },
  { brand: 'Lumen IQ', site: 'lumeniq.ai', score: 38 },
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
  const [stage, setStage] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchIndustries()
      .then((data) => setIndustries(data.industries || []))
      .catch(() => {});
  }, []);

  /* A domain typed on the landing panel arrives here already set. */
  useEffect(() => {
    try {
      const pre = localStorage.getItem('perceev_prescan_domain');
      if (pre) {
        setWebsite(pre);
        localStorage.removeItem('perceev_prescan_domain');
      }
    } catch {}
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

  const start = async () => {
    if (!validate()) return;

    try {
      const current = loadScan();
      const newBrand = brand.trim();
      const newWebsite = website.trim();
      if (current && (current.brand !== newBrand || current.website !== newWebsite)) {
        clearScan();
      }
    } catch {}

    setScanning(true);
    setFailed(false);
    setStage(0);
    setProgress(0);
    try {
      const result = await runScan(
        {
          brand: brand.trim(),
          website: website.trim(),
          industry: industry === '__custom__' ? customIndustry.trim() : industry,
          competitors: competitors.trim(),
        },
        (s, p) => {
          setStage(s);
          setProgress(p !== undefined ? p : Math.round(((s + 1) / STAGES.length) * 100));
        },
      );
      saveScan(result);
      toast.success('Route proved — reading ready');
      router.push('/dashboard');
    } catch (err) {
      setFailed(true);
      setScanning(false);
      toast.error(err?.message || 'The route could not be proved. Try again.');
    }
  };

  const reset = () => {
    if (scanning) return;
    setBrand('');
    setWebsite('');
    setIndustry('');
    setCustomIndustry('');
    setCompetitors('');
    setErrors({});
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--panel-0)' }}>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'var(--panel-1)',
          borderBottom: '1px solid var(--rule-1)',
          padding: '0 clamp(18px, 4vw, 32px)',
          height: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <Link href="/" aria-label="Perceev home" style={{ display: 'inline-flex' }}>
          <Wordmark size="sm" />
        </Link>
        <span className="plate">
          <Lamp lamp={scanning ? 'amber' : 'green'} size={6} calling={scanning} />
          <span className="t-plate">{scanning ? 'proving route' : 'entry panel'}</span>
        </span>
        <button type="button" onClick={reset} className="lp-link" style={{ marginLeft: 'auto' }}>
          clear
        </button>
      </header>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: 'clamp(32px, 6vw, 72px) clamp(18px, 4vw, 32px)' }}>
        {!scanning ? (
          <div>
            <h1
              className="t-sig"
              style={{ fontSize: 'clamp(28px, 4vw, 44px)', marginBottom: 'var(--space-4)' }}
            >
              Set a route for your brand
            </h1>
            <p
              style={{
                font: 'var(--type-body-lg)',
                color: 'var(--text-2)',
                marginBottom: 'var(--space-8)',
                lineHeight: 1.62,
                maxWidth: '62ch',
              }}
            >
              We put unbranded buyer questions to the answer engines and report which brand each
              answer clears the path to — including how often that brand is you.
            </p>

            <div className="sb-panel">
              <div className="sb-panel__head">
                <span className="t-plate">entry controls</span>
              </div>

              <div
                style={{
                  padding: 'var(--space-5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-5)',
                }}
              >
                <Input
                  id="brand"
                  data-testid="scan-brand-input"
                  label="brand or company name"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="Acme Analytics"
                  error={errors.brand}
                />

                <Input
                  id="website"
                  data-testid="scan-website-input"
                  label="website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="acme.com"
                  error={errors.website}
                />

                <Select
                  id="industry"
                  data-testid="scan-industry-input"
                  label="industry — optional"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  hint="Used only if we cannot source enough real queries."
                >
                  <option value="">Select an industry…</option>
                  {industries.map((ind) => (
                    <option key={ind.id} value={ind.id}>
                      {ind.label}
                    </option>
                  ))}
                  <option value="__custom__">Other — type your own…</option>
                </Select>

                {industry === '__custom__' && (
                  <Input
                    id="custom-industry"
                    data-testid="scan-custom-industry-input"
                    label="your industry"
                    value={customIndustry}
                    onChange={(e) => setCustomIndustry(e.target.value)}
                    placeholder="e.g. Dental equipment, Pet food, Drone services"
                  />
                )}

                <Input
                  id="competitors"
                  data-testid="scan-competitors-input"
                  label="rivals to track — optional"
                  value={competitors}
                  onChange={(e) => setCompetitors(e.target.value)}
                  placeholder="e.g. Kajaria, Somany"
                  hint="We also discover rivals from the answers themselves, so this list only adds to them."
                />

                <Button
                  data-testid="scan-submit-btn"
                  variant="primary"
                  size="lg"
                  onClick={start}
                  style={{ width: '100%' }}
                >
                  prove the route
                </Button>
              </div>
            </div>

            <div style={{ marginTop: 'var(--space-9)' }}>
              <span className="t-plate">sample readings · synthetic brands</span>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  gap: 1,
                  background: 'var(--rule-1)',
                  border: '1px solid var(--rule-1)',
                  borderRadius: 'var(--radius-2)',
                  marginTop: 'var(--space-3)',
                  overflow: 'hidden',
                }}
              >
                {RECENT.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    data-testid={`recent-scan-${i}`}
                    onClick={() => {
                      saveScan({
                        ...SAMPLE_RESULT,
                        brand: r.brand,
                        website: r.site,
                        visibilityScore: r.score,
                        isSample: true,
                      });
                      router.push('/dashboard');
                    }}
                    className="sb-entry"
                    style={{
                      display: 'grid',
                      gap: 9,
                      padding: 'var(--space-4) var(--space-5)',
                      background: 'var(--panel-1)',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ display: 'grid', gap: 2 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>
                        {r.brand}
                      </span>
                      <span className="t-stamp">{r.site}</span>
                    </span>
                    <Describer
                      value={String(r.score)}
                      size={20}
                      bloom={false}
                      lamp={r.score >= 50 ? 'green' : r.score >= 25 ? 'amber' : 'red'}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div data-testid="scan-loading" style={{ minHeight: '58vh' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                marginBottom: 'var(--space-5)',
                flexWrap: 'wrap',
              }}
            >
              <Describer value={String(progress).padStart(3, '0')} length={3} lamp="amber" size={44} />
              <span className="t-plate">per cent proved</span>
            </div>

            <h2 className="t-sig" style={{ fontSize: 'clamp(24px, 3.2vw, 36px)', marginBottom: 'var(--space-3)' }}>
              Proving the route for {brand}
            </h2>
            <p
              style={{
                color: 'var(--text-2)',
                font: 'var(--type-body)',
                marginBottom: 'var(--space-7)',
                maxWidth: '62ch',
                lineHeight: 1.6,
              }}
            >
              Every tracked question is being put to each engine in turn. A run that is interrupted
              picks up where it stopped, so this can safely take a few minutes.
            </p>

            <div style={{ marginBottom: 'var(--space-7)' }}>
              <TrackCircuit
                value={progress}
                max={100}
                sections={36}
                lamp="white"
                height={12}
                animate={false}
                label={`${progress} per cent proved`}
              />
            </div>

            <div className="sb-panel">
              <div className="sb-panel__head">
                <span className="t-plate">sections</span>
              </div>
              <div>
                {STAGES.map((s, i) => {
                  const done = i < stage;
                  const active = i === stage;
                  return (
                    <div
                      key={i}
                      data-testid={`scan-stage-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-4)',
                        padding: '13px var(--space-5)',
                        borderBottom: i === STAGES.length - 1 ? 'none' : '1px solid var(--rule-1)',
                        background: active ? 'var(--panel-2)' : 'transparent',
                      }}
                    >
                      <Lamp
                        lamp={done ? 'green' : active ? 'amber' : 'white'}
                        lit={done || active}
                        calling={active}
                        size={9}
                      />
                      <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: active ? 600 : 450,
                            color: active ? 'var(--text-1)' : done ? 'var(--text-2)' : 'var(--text-3)',
                          }}
                        >
                          {s.label}
                        </span>
                        <span className="t-stamp">{s.detail}</span>
                      </span>
                      <span
                        className="t-plate"
                        style={{
                          color: done
                            ? 'var(--lamp-green-text)'
                            : active
                            ? 'var(--lamp-amber-text)'
                            : 'var(--text-3)',
                        }}
                      >
                        {done ? 'clear' : active ? 'proving' : 'queued'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {failed && (
          <div style={{ marginTop: 'var(--space-6)' }}>
            <Alert data-testid="scan-error-banner" variant="crit" title="route not proved">
              The scan could not complete. Nothing was saved, so you can run it again without
              losing anything.
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
