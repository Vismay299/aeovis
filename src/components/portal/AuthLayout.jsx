import Link from "next/link";
import { PenLine, Radar, Search } from "lucide-react";
import "./portal.css";
import "./auth.css";

/**
 * Split-screen shell for the customer sign-in surfaces (login, signup,
 * onboarding, invite acceptance, password reset). Always light.
 * Styling lives in ./auth.css (pv-auth-* classes) on top of ./portal.css.
 */

const VALUE_ROWS = [
  { icon: Radar, text: "Track the questions buyers ask ChatGPT, Perplexity and Gemini" },
  { icon: PenLine, text: "Draft content AI engines can cite" },
  { icon: Search, text: "Connect Search Console in two clicks" },
];

const CARD_ROWS = [
  { name: "Your brand", share: 46, own: true },
  { name: "Competitor A", share: 31 },
  { name: "Competitor B", share: 18 },
];

function AnswerCard() {
  return (
    <div className="pv-auth-card" aria-hidden="true">
      <div className="pv-auth-card-head">
        <span className="pv-auth-card-tag">Illustrative</span>
      </div>
      <p className="pv-auth-card-question">
        “Which tools should a 20-person team use to track AI search visibility?”
      </p>
      <div className="pv-auth-card-rows">
        {CARD_ROWS.map((row) => (
          <div key={row.name} className={row.own ? "pv-auth-card-row is-own" : "pv-auth-card-row"}>
            <span className="pv-auth-card-name">{row.name}</span>
            <span className="pv-auth-card-bar">
              <span style={{ width: `${row.share}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * @param {{ eyebrow?: React.ReactNode; title: React.ReactNode; titleId?: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }} props
 */
export default function AuthLayout({ eyebrow = null, title, titleId, subtitle = null, children, footer = null }) {
  return (
    <div className="pv-auth">
      <div className="pv-auth-panel">
        <div className="pv-auth-top">
          <Link href="/" className="pv-auth-brand">
            <i aria-hidden="true" />
            perceev
          </Link>
        </div>

        <main className="pv-auth-main">
          <div className="pv-auth-form">
            {eyebrow ? <p className="pv-auth-eyebrow">{eyebrow}</p> : null}
            <h1 id={titleId} className="pv-auth-title">{title}</h1>
            {subtitle ? <p className="pv-auth-subtitle">{subtitle}</p> : null}
            <div className="pv-auth-fields">{children}</div>
            {footer ? <div className="pv-auth-note">{footer}</div> : null}
          </div>
        </main>

        <p className="pv-auth-legal">
          © Perceev <span aria-hidden="true">·</span> <Link href="/privacy">Privacy</Link>{" "}
          <span aria-hidden="true">·</span> <Link href="/terms">Terms</Link>
        </p>
      </div>

      <aside className="pv-auth-showcase">
        <div className="pv-auth-showcase-inner">
          <h2 className="pv-auth-pitch">See how AI answer engines talk about your brand.</h2>
          <ul className="pv-auth-values">
            {VALUE_ROWS.map(({ icon: Icon, text }) => (
              <li key={text} className="pv-auth-value">
                <span className="pv-auth-value-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <AnswerCard />
        </div>
      </aside>
    </div>
  );
}
