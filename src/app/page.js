'use client';

/*
PERCEEV — landing

Three ideas drive every decision on this page, in this order:
  1. The verdict is the product. Every surface leads to or from share of AI.
  2. Show the evidence. No score without the sentence that produced it.
  3. Unbranded or it doesn't count. The neutrality of the probe is the trust story.

Ported from design-options/prototype.src.html; see docs/design/DESIGN-SYSTEM.md.
Every figure below is the one reading quoted on every other surface (§10 of
that document) and every brand on it is fictional.
*/

import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { DEFAULT_UNBRANDED_TARGET } from '@/lib/scoring/promptSetSize';
import {
  ENGINE_LABELS, deployedEngineLabels, deployedEngines, formatEngineList,
} from '@/lib/engines/deployedEngines';
import { SiteNav } from '@/components/landing/SiteNav';
import { SiteFooter } from '@/components/landing/SiteFooter';
import { Reveal } from '@/components/landing/Reveal';
import { DomainField } from '@/components/landing/DomainField';
import { AnswerSheet } from '@/components/landing/AnswerSheet';
import { EngineRail } from '@/components/landing/EngineRail';
import { FlowDiagram } from '@/components/charts/FlowDiagram';
import { Reveal as RevealFlow } from '@/components/landing/Reveal';
import {
  CapabilityDeck, TrackedSetViz, TrendViz, RivalViz, SourcesViz,
} from '@/components/landing/CapabilityDeck';
import { saveScan } from '@/services/api';
import { SAMPLE_DESTINATIONS, SAMPLE_RESULT } from '@/data/mockData';

/* ── the one demonstration reading ──────────────────────────────────
   Nothing below is a number typed twice. TRACKED is the constant a scan runs
   on, the donut is the array the sample report renders, and the rail is that
   report's own per-engine tally.

   R2.10.1 — the first pass at this kept a SECOND copy of each and they drifted
   inside one commit: this page moved to 30 questions and 13/10/5/2 while the
   sample report one click away (src/data/mockData.js, reached from the "See a
   sample report" button below) stayed on 36 and 15/12/6/3, and still credited
   twelve of them to ChatGPT. landingHonesty.test.mjs asserts the tie now,
   rather than asking a human to hold two files in their head. */
// R2.10.1 — was a hardcoded 36 while a scan tracks 30 by default and every
// archived reference scan recorded prompts_tracked=30, so the page promised a
// fifth more than the product delivers. Now derived from the same constant the
// worker uses.
const TRACKED = DEFAULT_UNBRANDED_TARGET;

// R2.10.1 — the engines this deployment actually probes, not a hardcoded three.
// The hero used to name Google AI Overview, ChatGPT and Perplexity while the
// deployment ran ENGINES=aio,perplexity with no OPENAI_API_KEY at all, so
// ChatGPT could not have run even if it had been configured. Claiming an engine
// we do not probe is a claim about coverage, and it was wrong in the flattering
// direction. See src/lib/engines/deployedEngines.js.
const ENGINE_SENTENCE = formatEngineList(deployedEngineLabels());

const DEPLOYED_ENGINE_KEYS = deployedEngines();
const DEPLOYED_ENGINE_LABELS = deployedEngineLabels();

// The donut. Colour is presentation and belongs here; the counts are the sample
// report's own, so the two surfaces cannot disagree again.
const DESTINATION_COLOUR = {
  you: 'var(--you)', r1: 'var(--rival-1)', r2: 'var(--rival-2)', none: 'var(--rival-3)',
};
const DESTINATIONS = SAMPLE_DESTINATIONS.map((d) => ({
  ...d,
  colour: DESTINATION_COLOUR[d.key] ?? 'var(--rival-3)',
}));

// R2.10.1 — the rail showed a fixed three engines including ChatGPT, which this
// deployment does not probe, and derived `reached` from a hardcoded share per
// engine. Both the engines AND their tallies now come from the sample report:
// `asked`/`reached` are the rows it actually holds, so this gauge and the
// report behind the button cannot say different things.
const DEMO_ENGINES = DEPLOYED_ENGINE_KEYS.map((key) => {
  const stat = SAMPLE_RESULT.engines[key];
  if (!stat) {
    // Both lists come from deployedEngines(), so this is unreachable. If it
    // ever fires, a gauge with no reading behind it still LOOKS like a reading.
    throw new Error(
      `landing: the sample report holds no reading for "${key}", so this rail `
      + 'would render a gauge with nothing behind it.',
    );
  }
  return { name: ENGINE_LABELS[key], asked: stat.answered, reached: stat.visible };
});

// The rail says "the same N questions go to each", which is only true when the
// set divides evenly across the deployed engines. Take the smallest, so an
// uneven split under-claims rather than over-claims.
const PER_ENGINE_ASKED = DEMO_ENGINES.length
  ? Math.min(...DEMO_ENGINES.map((e) => e.asked))
  : 0;

// Prose only. Two of these notes used to carry arithmetic — "three of your four
// highest-intent questions", "six of its 64" — that was never true of the
// demonstration data behind them. The numbers on this rail are the gauges, and
// those are derived.
const ENGINE_NOTE = {
  'Google AI Overview': 'An AI Overview answer is the one your buyer reads without clicking anything.',
  ChatGPT: 'ChatGPT returns a single paragraph. There is no second place inside it.',
  Perplexity: 'Perplexity cites its sources, so a lost answer names the page that took it.',
};

const RAIL_NOTES = DEPLOYED_ENGINE_LABELS.map((name) => ENGINE_NOTE[name]).filter(Boolean);

const SLIDES = [
  {
    title: `${TRACKED} questions, none of which name you`,
    body: 'A leading question returns a flattering answer, so the set never contains one. Every entry is a phrasing a buyer would type on their own.',
    viz: <TrackedSetViz count={TRACKED} />,
  },
  {
    title: 'One number that moves',
    body: 'Share of AI is the share of answers that name you, stored per question and per engine so a page going live can be traced to the question it won.',
    viz: <TrendViz />,
  },
  {
    title: 'Rivals you did not know you had',
    body: 'Discovered from the answers themselves, ranked by how often each one takes a recommendation you wanted. You never maintain a competitor list.',
    viz: <RivalViz />,
  },
  {
    title: 'The 64 pages the engines drew on',
    body: 'Six of them are yours. The other fifty-eight are the shape of the work, and where the content operation starts.',
    viz: <SourcesViz total={64} mine={6} />,
  },
];

const FAQ = [
  {
    q: 'Why unbranded questions?',
    a: 'A branded question already contains the answer. Ask an engine “is Brightwave good for hospitals” and it will find something kind to say, because it is a completion machine and you handed it the premise. Your buyer types “best EHR for a 200-bed hospital”, and there the engine has to choose.',
  },
  {
    q: 'How is this different from rank tracking?',
    a: 'A rank tracker tells you where a page sits in a list of blue links. There is no list here. There is one paragraph naming two vendors, so we measure whether that paragraph says your name, and we keep the paragraph.',
  },
  {
    q: 'Does the number actually move?',
    a: 'Yes, and that is why it runs on a cadence. Readings are stored per question, per engine, per day, so when a question flips from a rival to you we can point at the page the engine started citing.',
  },
  {
    q: 'Does adding questions break my history?',
    a: 'No. The tracked set only ever grows additively, and the score is always a share of the set as it stood that day, so a reading from March stays comparable to one from August.',
  },
];

const CHECK = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--good)"
    strokeWidth="3" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export default function Landing() {
  const router = useRouter();

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push('/dashboard');
  };

  return (
    <>
      <SiteNav />

      {/* ── hero ─────────────────────────────────────────────────── */}
      <div className="hero shell">
        <div className="hero__grid">
          <div>
            <Reveal as="span" className="tag tag--brand">Answer-engine intelligence</Reveal>
            <Reveal as="h1" delay={60}>
              The answer names two brands. <em>Is one of them yours?</em>
            </Reveal>
            <Reveal as="p" className="lede hero__sub" delay={120}>
              Perceev asks {ENGINE_SENTENCE} the {TRACKED} unbranded
              questions your buyers actually type, then shows you which brand each answer
              recommends.
            </Reveal>
            <Reveal className="hero__form" delay={180}>
              <DomainField />
              <div className="hero__fine">
                <span>{CHECK} Free</span>
                <span>{CHECK} No signup</span>
                <span>{CHECK} Answers kept verbatim</span>
              </div>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                style={{ marginTop: 10, marginLeft: -15 }}
                onClick={viewSample}
                data-testid="preview-sample-cta"
              >
                See a sample report →
              </button>
            </Reveal>
          </div>

          <Reveal delay={240}>
            <AnswerSheet />
          </Reveal>
        </div>
      </div>

      {/* ── engine coverage ──────────────────────────────────────── */}
      <EngineRail engines={DEMO_ENGINES} notes={RAIL_NOTES} total={PER_ENGINE_ASKED} />

      {/* ── the gap: one statement, one graphic, air ──────────────── */}
      <section className="sec shell" id="gap">
        <Reveal className="sec__head sec__head--mid">
          <span className="tag tag--brand">The gap</span>
          <h2>Nobody scrolls to the fourth result any more.</h2>
          <p className="lede">
            An answer is not a queue you can join. It names two vendors, and the rest of the
            category does not exist for that buyer, on that day.
          </p>
        </Reveal>

        {/* the Reveal carries `is-in`, which releases the ribbons and labels */}
        <RevealFlow>
          <FlowDiagram
            total={TRACKED}
            destinations={DESTINATIONS}
            setLabel="UNBRANDED QUESTIONS"
          />
        </RevealFlow>

        <div className="legend">
          {DESTINATIONS.map((d) => (
            <span key={d.key}>
              <i style={{ background: d.colour }} />
              {d.label} · {d.answers}
            </span>
          ))}
        </div>
      </section>

      {/* ── what it does ─────────────────────────────────────────── */}
      <CapabilityDeck slides={SLIDES}>
        <span className="tag tag--brand">What it does</span>
        <h2>Four things arrive with every reading.</h2>
        <p>
          None of them ask you to configure anything first. Enter a domain and the rest happens on
          its own.
        </p>
        <Link className="btn btn--primary" style={{ marginTop: 24 }} href="/dashboard">
          Open a live report
        </Link>
      </CapabilityDeck>

      {/* ── evidence ─────────────────────────────────────────────── */}
      <section
        className="sec--tight"
        id="evidence"
        style={{ background: 'var(--surface)', borderBlock: '1px solid var(--line)' }}
      >
        <div className="shell sec" style={{ paddingBlock: 'clamp(52px,6vw,92px)' }}>
          <div className="ev">
            <Reveal>
              <span className="tag tag--brand">Evidence</span>
              <h2 style={{ margin: '18px 0 16px', fontSize: 'clamp(26px,3.1vw,40px)' }}>
                No score without the sentence that made it.
              </h2>
              <p className="dim" style={{ maxWidth: '38ch' }}>
                Every reading is backed by the text the engine actually returned, marked where your
                name appears and where a rival took the recommendation instead.
              </p>
              <Link
                className="btn btn--ghost"
                style={{ marginTop: 24 }}
                href="/dashboard?view=answers"
              >
                See all {TRACKED} answers
              </Link>
            </Reveal>

            <Reveal className="card" delay={100} style={{ padding: 'clamp(22px,2.6vw,32px)' }}>
              <div
                style={{
                  display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap',
                  paddingBottom: 16, borderBottom: '1px solid var(--line-soft)', marginBottom: 18,
                }}
              >
                {/* R2.10.1 — this card is an illustration with fictional brands
                    (NorthPeak, Brightwave). It carried a precise timestamp,
                    "16 Aug 2026 · 09:14 IST", which reads as provenance for a
                    real probe. A made-up answer wearing a real answer's
                    metadata is the exact confusion this page has to avoid. */}
                <span className="chip">Google AI Overview</span>
                <span className="tag">Sample · illustrative brands</span>
                <span className="chip chip--warn" style={{ marginLeft: 'auto' }}>Rival first</span>
              </div>
              <p
                style={{
                  fontSize: 17, fontWeight: 600, color: 'var(--ink-1)',
                  letterSpacing: '-.02em', marginBottom: 16,
                }}
              >
                &ldquo;best EHR platform for a 200-bed hospital&rdquo;
              </p>
              <p style={{ fontSize: 16, lineHeight: 1.85, color: 'var(--ink-2)' }}>
                For hospitals in the 150–300 bed range, <mark className="lit-rival">NorthPeak</mark>{' '}
                is the most frequently recommended platform, largely on the strength of its
                NABH-aligned reporting. <mark className="lit-you">Brightwave</mark> is named
                alongside it for outcome dashboards and readmission tracking, and is often preferred
                where clinical analytics matter more than billing workflow.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── objections ───────────────────────────────────────────── */}
      <section className="sec shell">
        <Reveal className="sec__head">
          <span className="tag tag--brand">Objections</span>
          <h2>Answered without marketing language.</h2>
        </Reveal>
        <Reveal className="faq">
          {FAQ.map((f, i) => (
            <details key={f.q} open={i === 0}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </Reveal>
      </section>

      {/* ── close ────────────────────────────────────────────────── */}
      <section className="close">
        <div className="shell close__in">
          <span className="tag tag--brand">Free · {TRACKED} questions · no signup</span>
          <h2>Find out what the engines say when you are not in the room.</h2>
          <p>
            Enter a domain. We ask the questions your buyers ask and report which brand each answer
            names.
          </p>
          <DomainField />
        </div>
      </section>

      <SiteFooter />
    </>
  );
}
