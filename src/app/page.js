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
import { SAMPLE_RESULT } from '@/data/mockData';

/* ── the one demonstration reading ──────────────────────────────────
   15 + 12 + 6 + 3 = 36. Change one of these and change all of them. */
const TRACKED = 36;

const DESTINATIONS = [
  { key: 'you', label: 'Brightwave', answers: 15, colour: 'var(--you)', isYou: true },
  { key: 'r1', label: 'NorthPeak', answers: 12, colour: 'var(--rival-1)' },
  { key: 'r2', label: 'Lumen IQ', answers: 6, colour: 'var(--rival-2)' },
  { key: 'none', label: 'No brand named', answers: 3, colour: 'var(--rival-3)', muted: true },
];

const DEMO_ENGINES = [
  { name: 'Google AI Overview', asked: 12, reached: 5 },
  { name: 'ChatGPT', asked: 12, reached: 6 },
  { name: 'Perplexity', asked: 12, reached: 4 },
];

const RAIL_NOTES = [
  'Three of your four highest-intent questions live in AI Overview.',
  "ChatGPT is your strongest engine, and your rivals' weakest.",
  'Perplexity cites sources hardest — six of its 64 are pages you control.',
];

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
              Perceev asks Google AI Overview, ChatGPT and Perplexity the {TRACKED} unbranded
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
      <EngineRail engines={DEMO_ENGINES} notes={RAIL_NOTES} total={12} />

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
                <span className="chip">Google AI Overview</span>
                <span className="tag">16 Aug 2026 · 09:14 IST</span>
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
