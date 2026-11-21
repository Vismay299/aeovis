'use client';

import {
  MARK_LOWER,
  MARK_UPPER,
  MARK_VIEWBOX,
  WORDMARK_GLYPHS,
  WORDMARK_VIEWBOX,
} from '@/components/app/brand/logoGeometry';

/** The Perceev mark and wordmark for the public site, in the text colour. */
export function SiteLogo() {
  return (
    <>
      <svg className="wordmark__mark" viewBox={MARK_VIEWBOX} fill="currentColor" aria-hidden="true"
        data-slot="perceev-mark" data-animated="">
        <path className="perceev-mark__lower" d={MARK_LOWER} />
        <path className="perceev-mark__upper" d={MARK_UPPER} />
      </svg>
      <svg className="wordmark__type" viewBox={WORDMARK_VIEWBOX} fill="currentColor" aria-hidden="true">
        <g transform="scale(1 -1)">
          {WORDMARK_GLYPHS.map(([x, d]) => (
            <path key={x} d={d} transform={`translate(${x} 0)`} />
          ))}
        </g>
      </svg>
    </>
  );
}

export default SiteLogo;
