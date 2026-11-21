"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PerceevMark } from "@/components/app/brand/PerceevLogo";

const LINKS = [
  { href: "#shift", label: "Why now" },
  { href: "#probe", label: "How it works" },
  { href: "#evidence", label: "Evidence" },
  { href: "#studio", label: "Studio" },
];

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="lp2-nav" data-scrolled={scrolled ? "true" : "false"}>
      <div className="lp2-nav__bar">
        <Link href="/" className="lp2-nav__brand" aria-label="Perceev home">
          <PerceevMark className="lp2-nav__mark" aria-hidden="true" />
          <span>perceev</span>
        </Link>
        <nav aria-label="Sections" className="lp2-nav__links">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>{l.label}</a>
          ))}
          <Link href="/methodology">Methodology</Link>
        </nav>
        <div className="lp2-nav__actions">
          <Link href="/login" className="lp2-nav__signin">Sign in</Link>
          <Link href="/scan" className="lp2-btn lp2-btn--sm">Free scan</Link>
        </div>
      </div>
    </header>
  );
}
