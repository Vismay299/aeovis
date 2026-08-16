'use client';

import Link from 'next/link';
import { Wordmark } from '@/components/landing/SiteNav';

/* The navy block is its own ground: labels there take the navy inks, never
   the page inks, which are tuned for paper. Handled in globals.css. */

export function SiteFooter() {
  return (
    <footer className="foot" data-testid="footer">
      <div className="shell">
        <div className="foot__g">
          <div>
            <Wordmark style={{ marginBottom: 12 }} />
            <p style={{ fontSize: '14.5px', maxWidth: '32ch', lineHeight: 1.55 }}>
              Answer-engine intelligence for teams whose buyers have stopped searching and started
              asking.
            </p>
          </div>
          <div>
            <h5>Product</h5>
            <Link href="/dashboard">Overview</Link>
            <Link href="/dashboard?view=answers">Answers</Link>
            <Link href="/dashboard?view=rivals">Rivals</Link>
            <Link href="/dashboard?view=sources">Sources</Link>
          </div>
          <div>
            <h5>Company</h5>
            <a href="#work">What it does</a>
            <a href="#evidence">Evidence</a>
            <a href="#gap">The gap</a>
            <Link href="/scan">Run a probe</Link>
          </div>
          <div>
            <h5>Legal</h5>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Data handling</a>
          </div>
        </div>
        <div className="foot__b">
          <span className="tag">© {new Date().getFullYear()} Perceev</span>
          <span className="tag">Demonstration data uses fictional brands</span>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
