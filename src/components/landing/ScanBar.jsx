'use client';

/**
 * The route-call control: a recessed field in the panel with the illuminated
 * pushbutton beside it. This is the one action on the page, so it is the one
 * lit lamp in its region.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/perceev/Button';

export const ScanBar = ({ className = '', id = 'scan-domain' }) => {
  const router = useRouter();
  const [domain, setDomain] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (domain.trim()) {
      localStorage.setItem('perceev_prescan_domain', domain.trim());
    }
    router.push('/scan');
  };

  return (
    <form onSubmit={handleSubmit} className={`lp-call ${className}`}>
      <label htmlFor={id} className="t-plate lp-call-plate">
        your domain
      </label>
      <div className="lp-call-row">
        <input
          id={id}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="yourcompany.com"
          autoComplete="url"
          spellCheck="false"
          className="sb-field sb-field--lg lp-call-field"
        />
        <Button variant="primary" size="lg" type="submit" className="lp-call-btn">
          run the probe
        </Button>
      </div>
    </form>
  );
};

export default ScanBar;
