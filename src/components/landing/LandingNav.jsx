'use client';

/**
 * The panel head rail: wordmark riveted at the left, engraved legends across
 * the middle, and the one lit action at the right.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Wordmark } from '@/components/perceev/Wordmark';
import { Button } from '@/components/perceev/Button';
import { Lamp } from '@/components/signal/Lamp';
import { saveScan } from '@/services/api';
import { SAMPLE_RESULT } from '@/data/mockData';

export const LandingNav = () => {
  const router = useRouter();

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push('/dashboard');
  };

  return (
    <header className="lp-nav">
      <div className="lp-container lp-nav-inner">
        <Link
          href="/"
          aria-label="Perceev home"
          style={{ display: 'inline-flex' }}
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          <Wordmark size="default" />
        </Link>

        <span className="lp-nav-plate">
          <Lamp lamp="green" size={6} />
          <span className="t-plate">answer engine interlocking</span>
        </span>

        <div className="lp-nav-links">
          <button type="button" className="lp-nav-link" onClick={() => scrollTo('route-setting')}>
            how it works
          </button>
          <button type="button" className="lp-nav-link" onClick={viewSample}>
            sample report
          </button>
          <Button variant="primary" size="md" onClick={() => router.push('/scan')}>
            run the probe
          </Button>
        </div>
      </div>
    </header>
  );
};

export default LandingNav;
