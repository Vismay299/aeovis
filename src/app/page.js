'use client';

/*
DIRECTION CONTRACT — The Signal Box
THESIS: answer-engine visibility is an interlocking, not a scoreboard. Only one
brand can hold the path in a given answer. Refuses the marketing stack the
category ships — no alternating splits, no eyebrow over every heading, no row
of feature cards.
OWN-WORLD: graphite panel steel, hairline track work, engraved nickel plates,
one bone-white lit state, three desaturated earth tones for data roles only.
Archivo cut into a signage voice, a body voice and a plate voice.
STORY: an executive watches unbranded questions get routed to somebody else's
name, sees the reading that produces, and runs the same probe on their domain.
FIRST VIEWPORT: the panel head with the one control, then the claim at signage
scale across the full width, the call beside it, and the live record running
under it. One continuous descent — the line starts below and runs unbroken to
the close.
FORM: grounded direction 3 of 7, seed 30239951; staging: one live thread pulled
down the panel — reaching a block lights its milepost.
*/

import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import '@/components/landing/landing.css';

import SmoothScroll from '@/components/signal/SmoothScroll';
import { Wordmark } from '@/components/perceev/Wordmark';
import { Button } from '@/components/perceev/Button';
import { ScanBar } from '@/components/landing/ScanBar';
import { LineTraversal } from '@/components/landing/LineTraversal';
import { LiveInterlocking } from '@/components/landing/LiveInterlocking';
import { AnswerSheet } from '@/components/landing/AnswerSheet';
import { Reveal } from '@/components/landing/Reveal';
import { HomeDashboard } from '@/components/home/HomeDashboard';
import { Describer } from '@/components/signal/Describer';
import { Lamp } from '@/components/signal/Lamp';
import { BlockInstrument } from '@/components/signal/BlockInstrument';
import { OccupancyRow } from '@/components/signal/TrackCircuit';
import { useProbeCycle, TRACKED_SET, YOU } from '@/components/landing/probeCycle';
import { saveScan } from '@/services/api';
import { SAMPLE_RESULT } from '@/data/mockData';

/* Demonstration figures, consistent with the tracked set above. Synthetic. */
const DEMO_FIELD = [
  { name: 'NorthPeak', value: 33 },
  { name: YOU, value: 25, isYou: true },
  { name: 'Lumen IQ', value: 17 },
  { name: 'no brand named', value: 25, muted: true },
];

const ENGINES = [
  { name: 'Google AI Overview', asked: 12, reached: 3, share: 0.25 },
  { name: 'Perplexity', asked: 12, reached: 4, share: 0.33 },
  { name: 'ChatGPT', asked: 12, reached: 2, share: 0.17 },
];

function Block({ n, id, title, lede, children }) {
  return (
    <section className="lp-blk" id={id}>
      <Reveal>
        <span className="lp-blk-post" aria-hidden="true">
          <i>{n}</i>
        </span>
        <h2 className="lp-blk-title">{title}</h2>
        {lede && <p className="lp-blk-lede">{lede}</p>}
        {children}
      </Reveal>
    </section>
  );
}

export default function Landing() {
  const router = useRouter();
  const { probe, lit, record, index, reduced } = useProbeCycle();

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push('/dashboard');
  };

  return (
    <SmoothScroll>
      <div className="lp">
        <HomeDashboard />

        {/* ============ the panel head ============ */}
        <header className="lp-head">
          <div className="lp-head-inner">
            <Wordmark size="default" />
            <span className="plate lp-head-live">
              <Lamp lamp="green" size={6} calling={!reduced} />
              <span className="t-plate">panel live</span>
            </span>
            <Button
              variant="primary"
              size="sm"
              className="lp-head-call"
              onClick={() => router.push('/scan')}
            >
              run the probe
            </Button>
          </div>
        </header>

        {/* ============ the claim ============ */}
        <section className="lp-hero">
          <div className="lp-hero-inner">
            <span className="t-plate lp-hero-plate">
              answer-engine visibility · demonstration panel
            </span>

            <h1 className="lp-claim">
              AI answers your buyers.
              <br />
              <em>Whose name does it say?</em>
            </h1>

            <div className="lp-hero-grid">
              <p className="lp-claim-sub">
                Google&apos;s AI Overview, ChatGPT and Perplexity now answer the questions your
                buyers used to search. Perceev asks them {TRACKED_SET.length * 3} unbranded buyer
                questions and shows you exactly which brand each answer clears the path to.
              </p>

              <div className="lp-hero-call">
                <ScanBar />
                <p className="lp-micro">Free · no signup · unbranded questions only</p>
                <button
                  type="button"
                  className="lp-link"
                  onClick={viewSample}
                  data-testid="preview-sample-cta"
                >
                  see a sample report <ArrowRight size={12} />
                </button>
              </div>
            </div>

            {/* the live record — the panel keeps its own log as it runs */}
            <div className="lp-record">
              <span className="t-plate lp-record-plate">record · demonstration</span>
              <ul className="lp-record-list">
                {record.length === 0 && (
                  <li className="lp-record-empty">waiting for the first route…</li>
                )}
                {record.map((r, i) => (
                  <li key={`${r.code}-${i}`}>
                    <Describer
                      value={r.code}
                      size={12}
                      bloom={false}
                      lamp={r.to === YOU ? 'white' : r.to === null ? 'amber' : 'red'}
                    />
                    <span className="lp-record-engine">{r.engine}</span>
                    <span
                      className="lp-record-to"
                      data-kind={r.to === YOU ? 'you' : r.to === null ? 'none' : 'rival'}
                    >
                      {r.to === null ? 'no route' : r.to}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ============ the line ============ */}
        <main className="lp-line">
          <div className="lp-line-inner">
            <LineTraversal />

            <Block
              n="1"
              id="the-questions"
              title="The questions go in unbranded"
              lede="Every probe is a question a buyer would actually type — and none of them name you. A leading question returns a flattering answer, so the set never contains one. This is the trust story: the verdict reflects what buyers hear, not what a vanity query returns."
            >
              <div className="lp-berths">
                {TRACKED_SET.map((t, i) => (
                  <div className="lp-berth" key={t.code}>
                    <Describer
                      value={t.code}
                      size={13}
                      bloom={false}
                      lamp={i === index ? 'white' : 'amber'}
                    />
                    <span className="lp-berth-q">{t.q}</span>
                  </div>
                ))}
              </div>
              <div className="lp-berths-foot">
                <span className="t-plate">12 of {TRACKED_SET.length * 3} shown</span>
                <span className="t-plate" style={{ color: 'var(--text-3)' }}>
                  demonstration set · healthcare
                </span>
              </div>
            </Block>

            <Block
              n="2"
              id="the-engines"
              title="Each one is asked of every engine"
              lede="The same question goes to every answer engine you are configured for, because they disagree. A brand that owns AI Overview can be invisible in Perplexity, and averaging the two hides it."
            >
              <div className="lp-engines">
                {ENGINES.map((e) => (
                  <div className="lp-engine" key={e.name}>
                    <span className="lp-engine-name">
                      <Lamp lamp={e.reached > 0 ? 'green' : 'red'} size={7} />
                      {e.name}
                    </span>
                    <span className="lp-engine-line">
                      <span style={{ width: `${e.share * 100}%` }} />
                    </span>
                    <span className="lp-engine-note">
                      {e.reached} of {e.asked} reached you
                    </span>
                  </div>
                ))}
              </div>
            </Block>

            <Block
              n="3"
              id="the-interlocking"
              title="Only one brand can hold the path"
              lede="Watch a single question resolve. The engine clears a route to exactly one destination — you, a rival, or nobody at all. Every route that terminates somewhere else is one you could have held."
            >
              <LiveInterlocking probe={probe} lit={lit} reduced={reduced} />
            </Block>

            <Block
              n="4"
              id="the-reading"
              title="What that adds up to"
              lede="Run the whole set and the pattern stops being anecdotal. This is the reading a demonstration scan produces, and the field it produced it against."
            >
              <div className="lp-reading">
                <BlockInstrument value={25} size={252} caption="of answers reach you" />
                <div className="lp-reading-field">
                  <span className="t-plate">where the rest of the answers went</span>
                  <div style={{ marginTop: 12 }}>
                    {DEMO_FIELD.map((f, i) => (
                      <OccupancyRow
                        key={f.name}
                        name={f.name}
                        value={f.value}
                        max={40}
                        rank={i + 1}
                        isYou={f.isYou}
                        lamp={f.muted ? 'amber' : 'red'}
                      />
                    ))}
                  </div>
                  <p className="lp-micro" style={{ marginTop: 14 }}>
                    Rivals are discovered from the answers themselves — co-mentions and citations,
                    not a list you maintain.
                  </p>
                </div>
              </div>
            </Block>

            <Block
              n="5"
              id="the-evidence"
              title="With the answer kept verbatim"
              lede="Every reading is backed by the text the engine actually returned, marked where your name appears and where a rival took the section instead. No paraphrase, no score without its evidence."
            >
              <AnswerSheet />
            </Block>

            {/* ---- the close ---- */}
            <section className="lp-close" id="run">
              <Reveal>
                <span className="lp-buffer" aria-hidden="true">
                  <i />
                </span>
                <h2 className="lp-close-title">Run the same probe on your domain</h2>
                <p className="lp-blk-lede">
                  Enter a domain and Perceev asks the engines the questions your buyers ask, then
                  reports which brand each answer names. No signup, no card.
                </p>
                <div className="lp-close-call">
                  <ScanBar id="scan-domain-close" />
                </div>
                <p className="lp-micro">
                  You will get a share-of-AI reading, the field it was measured against, and every
                  answer verbatim.
                </p>
              </Reveal>
            </section>
          </div>
        </main>

        <footer className="lp-footer" data-testid="footer">
          <div className="lp-footer-inner">
            <Wordmark size="sm" />
            <span className="lp-footer-copy">
              © {new Date().getFullYear()} Perceev · Demonstration data on this page uses fictional
              brands.
            </span>
            <Button variant="secondary" size="sm" onClick={() => router.push('/scan')}>
              run the probe
            </Button>
          </div>
        </footer>
      </div>
    </SmoothScroll>
  );
}
