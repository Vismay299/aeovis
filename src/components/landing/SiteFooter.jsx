'use client';

import Footer from '@/components/landing2/Footer';
import '@/components/landing2/landing2.css';

/* The public pages' footer is the home page's footer, without its note about
   sample brands (these pages show none). */
export function SiteFooter() {
  return (
    <div className="lp2 lp2--chrome">
      <Footer note={null} />
    </div>
  );
}

export default SiteFooter;
