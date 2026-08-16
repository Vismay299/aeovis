'use client';

/**
 * The one action on the page: a domain goes in, a probe comes out.
 * A pill field with the submit button living inside it.
 */

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';

export function DomainField({
  className = '',
  label = 'Your domain',
  cta = 'Run the probe',
  onNavigate,
}) {
  const router = useRouter();
  const id = useId();
  const [domain, setDomain] = useState('');

  const submit = (e) => {
    e.preventDefault();
    const value = domain.trim();
    if (value) {
      try {
        localStorage.setItem('perceev_prescan_domain', value);
      } catch {
        /* the scan screen asks again if this could not be stored */
      }
    }
    if (onNavigate) onNavigate(value);
    router.push('/scan');
  };

  return (
    <form className={`field ${className}`.trim()} onSubmit={submit}>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        placeholder="yourcompany.com"
        autoComplete="url"
        spellCheck="false"
        data-testid="landing-domain-input"
      />
      <button className="btn btn--primary" type="submit" data-testid="landing-scan-cta">
        {cta}
      </button>
    </form>
  );
}

export default DomainField;
