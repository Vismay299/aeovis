'use client';

import Link from 'next/link';
import { SiteLogo } from './SiteLogo';

export function Wordmark({ className = '', style }) {
  return (
    <span className={`wordmark ${className}`.trim()} style={style} role="img" aria-label="Perceev">
      <SiteLogo />
    </span>
  );
}

export function SiteNav() {
  return (
    <header className="nav">
      <div className="shell nav__in">
        <Link href="/" aria-label="Perceev home"><Wordmark /></Link>
        <div className="nav__links">
          <Link href="/#gap">The gap</Link>
          <Link href="/#work">What it does</Link>
          <Link href="/methodology">Methodology</Link>
        </div>
        <div className="nav__r">
          <Link className="btn btn--quiet btn--sm" href="/login">Sign in</Link>
          <Link className="btn btn--primary btn--sm" href="/scan">Run a free probe</Link>
        </div>
      </div>
    </header>
  );
}

export default SiteNav;
