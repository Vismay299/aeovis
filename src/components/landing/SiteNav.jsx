'use client';

import { SiteLogo } from './SiteLogo';
import Nav from '@/components/landing2/Nav';
import '@/components/landing2/landing2.css';

export function Wordmark({ className = '', style }) {
  return (
    <span className={`wordmark ${className}`.trim()} style={style} role="img" aria-label="Perceev">
      <SiteLogo />
    </span>
  );
}

/**
 * The public pages' header: the home page's floating nav, with its section
 * links pointed back at the home page. The spacer clears the fixed bar.
 */
export function SiteNav() {
  return (
    <div className="lp2 lp2--chrome">
      <Nav base="/" />
      <div className="lp2-nav-spacer" aria-hidden="true" />
    </div>
  );
}

export default SiteNav;
