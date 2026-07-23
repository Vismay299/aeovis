"use client";

/*
DIRECTION CONTRACT — Results Night
THESIS: AI is calling the race for your buyers; this page is the results
broadcast of that election. Refuses the dark-SaaS glow-hero the category ships.
OWN-WORLD: blue-black studio wall, gold declarations, teal=you / red=rivals
party colors, condensed uppercase tallies, live crawl, straps as segment marks.
STORY: an executive realizes the count is already running without them, sees
the tally and the verbatim answers, and runs their own count (free scan).
FIRST VIEWPORT: topline strap (LIVE · ANSWER ENGINE RESULTS), giant condensed
headline left, live tally board right (4 parties, threshold line), scan desk
with gold RUN THE COUNT beneath the headline, probe crawl along the bottom.
FORM: candidate 7 of the grounded list (election results broadcast), assigned
by concept seed 5f228d86; staging: studio-wall single frame, crawl retained.
*/

import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import "@/components/landing/landing.css";
import { LandingNav } from "@/components/landing/LandingNav";
import { HomeDashboard } from "@/components/home/HomeDashboard";
import { ScanBar } from "@/components/landing/ScanBar";
import { AnswerDemo } from "@/components/landing/AnswerDemo";
import { CountUp } from "@/components/landing/CountUp";
import { EvidenceTicker } from "@/components/landing/EvidenceTicker";
import { Reveal } from "@/components/landing/Reveal";
import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Badge } from "@/components/perceev/Badge";
import { Wordmark } from "@/components/perceev/Wordmark";
import { saveScan } from "@/services/api";
import { SAMPLE_RESULT } from "@/data/mockData";

/* Synthetic demonstration tally — fictional brands, labeled in the board head.
   Brightwave is the demo "you" everywhere on this page (crawl, soundbite, tally). */
const TALLY = [
  { name: "NorthPeak", score: 71 },
  { name: "Brightwave", score: 64, you: true },
  { name: "Lumen IQ", score: 58 },
  { name: "Vantage", score: 38 },
];

const STEPS = [
  {
    num: "seg 1",
    title: "Enter your domain",
    body: "No signup, no credit card. Just the website you want counted.",
  },
  {
    num: "seg 2",
    title: "We run the count",
    body: "30 unbranded buyer prompts hit the engines your customers actually use — never leading, never branded.",
  },
  {
    num: "seg 3",
    title: "The projection lands",
    body: "A share-of-AI score, the answers verbatim, and the rivals ahead of you — in about a minute.",
  },
];

export default function Landing() {
  const router = useRouter();

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push("/dashboard");
  };

  return (
    <div className="lp">
      <LandingNav />

      {/* Case files shelf — previous runs, one slim row. Renders nothing
          for first-time visitors. */}
      <HomeDashboard />

      <main>
        {/* ---------- Hero — the studio wall ---------- */}
        <section className="lp-hero">
          <div className="lp-container lp-hero-main">
            <div className="lp-hero-topline">
              <span className="lp-live">
                <span className="lp-live-dot" />
                Live
              </span>
              <span className="lp-topline-title">Answer engine results · every buyer question</span>
              <span className="lp-topline-stamp">30 probes / scan · 60s to verdict</span>
            </div>

            <div className="lp-hero-grid">
              <div>
                <h1 className="lp-hero-title">
                  AI is calling the race for your buyers.
                  <br />
                  <span className="mark-sweep is-animated">Are you winning?</span>
                </h1>

                <p className="lp-hero-sub">
                  Google&apos;s AI Overview, ChatGPT, and Perplexity answer buyer questions
                  directly — and declare winners by name. Perceev probes them with 30 unbranded
                  buyer prompts and reports your share of AI, live.
                </p>

                <div className="lp-hero-scan">
                  <ScanBar />
                  <p className="lp-hero-micro">free · no signup · 60-second scan</p>
                </div>
              </div>

              {/* The live tally board — synthetic demonstration */}
              <div className="tally is-live" style={{ "--threshold": 0.6 }}>
                <div className="tally-head">
                  <span className="tally-title">Share of AI · live tally</span>
                  <span className="tally-declared">demo data · probes in: 24/30</span>
                </div>
                <div className="tally-body">
                  <div className="tally-threshold">
                    <span>visibility threshold</span>
                  </div>
                  {TALLY.map((row, i) => (
                    <div
                      key={row.name}
                      className={`tally-row${row.you ? " is-you" : ""}`}
                      style={{ "--i": i }}
                    >
                      <span className="tally-name">
                        <i className="tally-chip" />
                        {row.name}
                        {row.you && <em className="tally-you-tag">you</em>}
                      </span>
                      <div className="tally-track">
                        <div className="tally-fill" style={{ "--v": row.score }} />
                      </div>
                      <span className="tally-count">
                        <CountUp value={row.score} delay={i * 120 + 200} />
                      </span>
                    </div>
                  ))}
                </div>
                <div className="tally-foot">
                  <span>engines: aio · chatgpt · perplexity</span>
                  <span>unbranded prompts only</span>
                </div>
              </div>
            </div>
          </div>

          {/* The crawl — probe results wire */}
          <EvidenceTicker />
        </section>

        {/* ---------- The shift ---------- */}
        <section className="lp-section" id="the-shift">
          <div className="lp-container">
            <Reveal>
              <div className="lp-sec-head">
                <span className="lp-strap">
                  The shift <small>· why this race matters</small>
                </span>
              </div>
              <div className="lp-split">
                <div>
                  <h2 className="lp-h2">Buyers stopped clicking. They ask AI.</h2>
                  <p className="lp-body">
                    Every day, more buying decisions start — and end — inside a single AI answer.
                    If the engines don&apos;t know you, your buyers never will. Ranking #1 on
                    Google means nothing when the answer box above it never says your name.
                  </p>
                </div>
                {/* The soundbite — a probe answer, verbatim */}
                <div className="lp-sheet">
                  <div className="lp-sheet-head">
                    <span>
                      probe feed · <b>unbranded</b> · rotating
                    </span>
                    <span>verbatim</span>
                  </div>
                  <div className="lp-sheet-body">
                    <AnswerDemo />
                  </div>
                  <div className="lp-sheet-foot">
                    <span className="lp-legend">
                      <i className="lp-legend-mark" />
                      you, named
                    </span>
                    <span className="lp-legend">
                      <i className="lp-legend-rival" />
                      rival, named
                    </span>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- The projection — verdict segment ---------- */}
        <section className="lp-projection-band" id="the-verdict">
          <div className="lp-container">
            <Reveal>
              <div className="lp-sec-head">
                <span className="lp-strap">
                  The projection <small>· one score, called early</small>
                </span>
              </div>
              <div className="lp-split">
                <div>
                  <h2 className="lp-h2">One score. Your share of AI.</h2>
                  <p className="lp-body">
                    Every scan runs 30 unbranded prompts across real buyer scenarios, then
                    distills the answers into a single share-of-AI score — how often the engines
                    mention you, cite you, and where you actually stand against the field.
                  </p>
                </div>
                <div className="lp-projection">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-4)", alignItems: "baseline" }}>
                    <span className="lp-projection-stamp">Projection · moderate visibility</span>
                    <span className="tally-declared">demo data</span>
                  </div>
                  <div className="lp-projection-num">
                    <strong>
                      <CountUp value={64} />
                    </strong>
                    <span>/100</span>
                  </div>
                  <div className="lp-projection-meter">
                    <ScoreMeter segments={30} value={64} />
                  </div>
                  <div className="lp-projection-splits">
                    <div className="lp-projection-split">
                      <strong>19/30</strong>
                      <span>probes name you</span>
                    </div>
                    <div className="lp-projection-split">
                      <strong>8/30</strong>
                      <span>cite your pages</span>
                    </div>
                    <div className="lp-projection-split">
                      <strong>1</strong>
                      <span>rival ahead</span>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- The rivalry ---------- */}
        <section className="lp-section" id="the-rivalry">
          <div className="lp-container">
            <Reveal>
              <div className="lp-sec-head">
                <span className="lp-strap">
                  The rivalry <small>· the field AI actually names</small>
                </span>
              </div>
              <div className="lp-split">
                <div>
                  <h2 className="lp-h2">Your rivals are already on the board</h2>
                  <p className="lp-body">
                    Every scan benchmarks you against the competitors AI actually names — not the
                    ones you think you have. Their leads, their wins, and the gap you have to
                    close, updated with every count.
                  </p>
                  <p className="lp-body" style={{ marginTop: "var(--space-4)" }}>
                    <Badge variant="accent">auto-discovered</Badge>{" "}
                    <span style={{ fontSize: "14px" }}>
                      Rivals come from the answers themselves — co-mentions and citations, not a
                      list you maintain.
                    </span>
                  </p>
                </div>
                <div className="tally" style={{ "--threshold": 0.6 }}>
                  <div className="tally-head">
                    <span className="tally-title">The field · gap to you</span>
                    <span className="tally-declared">demo data</span>
                  </div>
                  <div className="tally-body">
                    <div className="tally-threshold">
                      <span>visibility threshold</span>
                    </div>
                    {TALLY.map((row, i) => (
                      <div
                        key={row.name}
                        className={`tally-row${row.you ? " is-you" : ""}`}
                        style={{ "--i": i }}
                      >
                        <span className="tally-name">
                          <i className="tally-chip" />
                          {row.name}
                        </span>
                        <div className="tally-track">
                          <div className="tally-fill" style={{ "--v": row.score }} />
                        </div>
                        <span className="tally-count">
                        <CountUp value={row.score} delay={i * 120 + 200} />
                      </span>
                      </div>
                    ))}
                  </div>
                  <div className="tally-foot">
                    <span>you trail NorthPeak by 7 · you lead Lumen IQ by 6</span>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- The rundown (how it works) ---------- */}
        <section className="lp-section" id="how-it-works">
          <div className="lp-container">
            <Reveal>
              <div className="lp-sec-head">
                <span className="lp-strap">
                  The rundown <small>· domain in, verdict out</small>
                </span>
              </div>
              <h2 className="lp-h2">Sixty seconds to your first count</h2>
              <div className="lp-steps">
                {STEPS.map((step) => (
                  <div key={step.num} className="lp-step">
                    <span className="lp-step-num">{step.num}</span>
                    <h3 className="lp-step-title">{step.title}</h3>
                    <p className="lp-step-body">{step.body}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- Final CTA ---------- */}
        <section className="lp-cta" id="begin">
          <div className="lp-container">
            <Reveal>
              <h2 className="lp-cta-title">
                The count is on. <span className="mark-sweep">Enter the race.</span>
              </h2>
              <p className="lp-cta-sub">
                Run a visibility check in under a minute. No signup. No credit card. Just your
                domain — we&apos;ll probe the rest.
              </p>
              <div className="lp-hero-scan" style={{ marginTop: 0 }}>
                <ScanBar />
              </div>
              <div>
                <button
                  className="lp-sample-link"
                  data-testid="preview-sample-cta"
                  onClick={viewSample}
                >
                  See a sample report
                  <ArrowRight size={14} />
                </button>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ---------- Footer ---------- */}
      <footer className="lp-footer" data-testid="footer">
        <div className="lp-container lp-footer-inner">
          <Wordmark size="sm" />
          <span className="lp-footer-copy">
            © {new Date().getFullYear()} Perceev. All rights reserved.
          </span>
        </div>
      </footer>
    </div>
  );
}
