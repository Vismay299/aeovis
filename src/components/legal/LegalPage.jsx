/**
 * Shared layout for the privacy and terms pages: site chrome, brand eyebrow,
 * title, revision date, body and back link. The two pages differ only in copy,
 * so they pass that copy as children rather than repeating this shell.
 */

import Link from "next/link";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { LEGAL_CONTACT_EMAIL, LEGAL_LAST_UPDATED } from "@/lib/legal";

/** The one place the contact address is turned into a mailto link. */
export function LegalContact() {
  return <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>;
}

export default function LegalPage({ eyebrow, title, children }) {
  return (
    <>
      <SiteNav />
      <main className="legal-page shell">
        <p className="tag tag--brand">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="legal-page__updated">Last updated: {LEGAL_LAST_UPDATED}</p>
        {children}
        <p className="legal-page__back"><Link href="/">Back to Perceev</Link></p>
      </main>
      <SiteFooter />
    </>
  );
}
