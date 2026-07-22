"use client";

import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import "@/components/landing/landing.css";
import { LandingNav } from "@/components/landing/LandingNav";
import { ScanBar } from "@/components/landing/ScanBar";
import { AnswerDemo } from "@/components/landing/AnswerDemo";
import { ProbeCounter } from "@/components/landing/ProbeCounter";
import { Reveal } from "@/components/landing/Reveal";
import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Badge } from "@/components/perceev/Badge";
import { Wordmark } from "@/components/perceev/Wordmark";
import { saveScan } from "@/services/api";
import { SAMPLE_RESULT } from "@/data/mockData";

const RIVALS = [
  { name: "You", score: 64, gap: null, you: true },
  { name: "NorthPeak", score: 71, gap: "+7" },
  { name: "Lumen IQ", score: 58, gap: "-6" },
  { name: "Brightwave", score: 38, gap: "-26" },
];

const STEPS = [
  {
    num: "01",
    title: "Enter your domain",
    body: "No signup, no credit card. Just the website you want checked.",
  },
  {
    num: "02",
    title: "We probe the AI",
    body: "30 unbranded buyer prompts hit the engines your customers actually use — never leading, never branded.",
  },
  {
    num: "03",
    title: "Get your verdict",
    body: "A share-of-AI score, the answers verbatim, and the rivals beating you — in about a minute.",
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

      <main>
        {/* ---------- Hero ---------- */}
        <section className="lp-hero">
          <div className="lp-hero-glow" />
          <div className="lp-container lp-hero-inner">
            <span className="lp-eyebrow">
              <span className="lp-eyebrow-dot" />
              Answer engine intelligence
            </span>

            <h1 className="lp-hero-title">
              When AI answers, does it name <span style={{ color: "var(--accent)" }}>you</span> — or
              your rival?
            </h1>

            <p className="lp-hero-sub">
              Google&apos;s AI Overview, ChatGPT, and Perplexity now answer buyer questions directly
              — often without sending anyone to a website. Brands that don&apos;t appear in those
              answers are invisible to the next generation of search.
            </p>

            <div className="lp-hero-scan">
              <ScanBar />
              <p className="lp-hero-micro">Free · No signup · 60-second scan</p>
            </div>

            {/* Live AI answer window */}
            <Reveal>
              <p className="lp-answer-caption">This is what AI tells your buyers</p>
              <div className="lp-answer-window">
                <div className="lp-answer-head">
                  <div className="lp-answer-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="lp-answer-title">ai overview · live probe</span>
                </div>
                <div className="lp-answer-body">
                  <AnswerDemo />
                </div>
                <div className="lp-answer-foot">
                  <span className="lp-legend">
                    <i style={{ background: "var(--good)" }} />
                    Your brand
                  </span>
                  <span className="lp-legend">
                    <i style={{ background: "var(--crit)" }} />
                    Rivals
                  </span>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- Stats strip ---------- */}
        <section className="lp-stats">
          <div className="lp-container">
            <div className="lp-stats-grid">
              <div className="lp-stat">
                <ProbeCounter />
                <div className="lp-stat-label">Probes run</div>
              </div>
              <div className="lp-stat">
                <div className="lp-stat-value">30</div>
                <div className="lp-stat-label">Prompts per scan</div>
              </div>
              <div className="lp-stat">
                <div className="lp-stat-value">60s</div>
                <div className="lp-stat-label">To a verdict</div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- The shift ---------- */}
        <section className="lp-section" id="the-shift">
          <div className="lp-container">
            <Reveal>
              <div className="lp-split">
                <div>
                  <span className="lp-kicker">01 · The shift</span>
                  <h2 className="lp-h2">Buyers don&apos;t click links anymore — they ask AI</h2>
                </div>
                <p className="lp-body">
                  Every day, more buying decisions start — and end — inside a single AI answer. If
                  the engines don&apos;t know you, your buyers never will. Ranking #1 on Google
                  means nothing when the answer box above it never mentions your name.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- The verdict ---------- */}
        <section className="lp-section" id="the-verdict">
          <div className="lp-container">
            <Reveal>
              <div className="lp-split">
                <div>
                  <span className="lp-kicker">02 · The verdict</span>
                  <h2 className="lp-h2">One score. Your share of AI.</h2>
                  <p className="lp-body">
                    Every scan runs 30 unbranded prompts across real buyer scenarios, then distills
                    the answers into a single share-of-AI score — how often the engines mention
                    you, cite you, and where you actually stand.
                  </p>
                </div>
                <div className="lp-verdict-card">
                  <div className="lp-verdict-top">
                    <div className="lp-verdict-score">
                      <span className="lp-verdict-num">64</span>
                      <span className="lp-verdict-denom">/100</span>
                    </div>
                    <Badge variant="moderate">Moderate</Badge>
                  </div>
                  <ScoreMeter segments={40} value={64} />
                  <div className="lp-verdict-meta">
                    <span>Mentioned 18/20 AIOs</span>
                    <span>Cited in 6/20</span>
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
              <div className="lp-narrow">
                <span className="lp-kicker">03 · The rivalry</span>
                <h2 className="lp-h2">Your rivals are already there</h2>
                <p className="lp-body">
                  Every scan benchmarks you against the competitors AI actually names — not the
                  ones you think you have.
                </p>
              </div>
              <div className="lp-rival-list lp-narrow">
                {RIVALS.map((rival) => (
                  <div key={rival.name} className={`lp-rival${rival.you ? " is-you" : ""}`}>
                    <span className="lp-rival-name">
                      {rival.name}
                      {rival.you && <Badge variant="accent">You</Badge>}
                    </span>
                    <div className="lp-rival-meter">
                      <ScoreMeter segments={30} value={rival.score} />
                    </div>
                    <span className="lp-rival-score">{rival.score}</span>
                    <span className="lp-rival-gap">
                      {rival.gap ? (
                        <Badge variant={parseFloat(rival.gap) > 0 ? "weak" : "strong"}>
                          {rival.gap}
                        </Badge>
                      ) : (
                        <Badge variant="neutral">Base</Badge>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- How it works ---------- */}
        <section className="lp-section" id="how-it-works">
          <div className="lp-container">
            <Reveal>
              <div className="lp-narrow">
                <span className="lp-kicker">04 · How it works</span>
                <h2 className="lp-h2">Domain in. Verdict out.</h2>
              </div>
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
          <div className="lp-cta-glow" />
          <div className="lp-container lp-cta-inner">
            <Reveal>
              <h2 className="lp-cta-title">Start your first scan</h2>
              <p className="lp-cta-sub">
                Run a visibility check in under a minute. No signup. No credit card. Just your
                domain and we&apos;ll probe the rest.
              </p>
              <div className="lp-hero-scan">
                <ScanBar />
              </div>
              <button className="lp-sample-link" data-testid="preview-sample-cta" onClick={viewSample}>
                See a sample report
                <ArrowRight size={14} />
              </button>
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
