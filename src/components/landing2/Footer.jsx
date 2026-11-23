import Link from "next/link";
import { PerceevMark } from "@/components/app/brand/PerceevLogo";

const COLUMNS = [
  { h: "Product", links: [{ href: "/scan", l: "Free scan" }, { href: "/methodology", l: "Methodology" }, { href: "/use-cases", l: "Use cases" }, { href: "/demo", l: "Simulated workflow" }] },
  { h: "Account", links: [{ href: "/login", l: "Sign in" }, { href: "/signup", l: "Create account" }] },
  { h: "Legal", links: [{ href: "/privacy", l: "Privacy" }, { href: "/terms", l: "Terms" }] },
];

const HOME_NOTE = "Brands shown on this page are fictional sample data.";

export default function Footer({ note = HOME_NOTE }) {
  return (
    <footer className="lp2-footer" data-testid="footer">
      <div className="lp2-wrap lp2-footer__grid">
        <div className="lp2-footer__brand">
          <span className="lp2-nav__brand"><PerceevMark animated={false} className="lp2-nav__mark" /><span>perceev</span></span>
          <p className="lp2-muted">Answer-engine intelligence. See which brand AI recommends when your buyers ask.</p>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.h} aria-label={c.h} className="lp2-footer__col">
            <h2>{c.h}</h2>
            <ul>
              {c.links.map((x) => <li key={x.href}><Link href={x.href}>{x.l}</Link></li>)}
            </ul>
          </nav>
        ))}
      </div>
      <div className="lp2-wrap lp2-footer__base">
        {note ? <span>{note}</span> : <span />}
        <span className="lp2-footer__word" aria-hidden="true">perceev</span>
      </div>
    </footer>
  );
}
