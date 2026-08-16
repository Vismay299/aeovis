'use client';

import Link from 'next/link';
import { ThemeToggle } from '@/components/perceev/ThemeToggle';

export function Wordmark({ className = '', style }) {
  return (
    <span className={`wordmark ${className}`.trim()} style={style}>
      <span className="wordmark__m">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff"
          strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6" />
          <path d="M15.5 15.5L21 21" />
        </svg>
      </span>
      perceev
    </span>
  );
}

export function SiteNav() {
  return (
    <header className="nav">
      <div className="shell nav__in">
        <Link href="/" aria-label="Perceev home"><Wordmark /></Link>
        <div className="nav__links">
          <a href="#gap">The gap</a>
          <a href="#work">What it does</a>
          <a href="#evidence">Evidence</a>
        </div>
        <div className="nav__r">
          <ThemeToggle />
          <Link className="btn btn--quiet btn--sm" href="/dashboard">Sign in</Link>
          <Link className="btn btn--primary btn--sm" href="/scan">Run a free probe</Link>
        </div>
      </div>
    </header>
  );
}

export default SiteNav;
