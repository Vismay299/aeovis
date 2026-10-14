import Link from "next/link";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";

export const metadata = {
  title: "Terms of Service | Perceev",
  description: "Terms for using the Perceev website and customer workspace.",
};

export default function TermsPage() {
  return (
    <>
      <SiteNav />
      <main className="legal-page shell">
        <p className="tag tag--brand">TERMS</p>
        <h1>Terms of Service</h1>
        <p className="legal-page__updated">Last updated: October 11, 2026</p>
        <p>
          These terms cover your access to the Perceev website and customer workspace. By using
          Perceev, you agree to use it lawfully and to follow these terms. If you use Perceev for a
          company, you confirm that you are allowed to act for that company.
        </p>

        <h2>Your account and workspace</h2>
        <p>
          Keep your sign-in details secure and make sure information you add to a workspace is
          accurate. Workspace owners are responsible for inviting the right people and choosing
          the Google Search Console property that belongs to their organization. Each customer
          must connect their own Google account and must have permission to authorize the selected
          property.
        </p>

        <h2>Connected services and customer content</h2>
        <p>
          If you connect Google Search Console, you authorize Perceev to read the selected property
          using the read-only permission described in our <Link href="/privacy">Privacy Policy</Link>.
          You can disconnect it from your workspace or revoke access through Google. You retain
          responsibility for content, domains, and other materials you submit to Perceev, including
          ensuring that you have the rights needed to use them.
        </p>

        <h2>Reports and generated content</h2>
        <p>
          Perceev reports and AI-generated content are provided to help you analyze and improve
          your work. Search visibility and answer-engine results can change, and generated content
          may be incomplete or incorrect. Review outputs and verify important decisions before
          relying on them or publishing them.
        </p>

        <h2>Use of the service</h2>
        <p>
          Do not use Perceev to break the law, access another customer’s workspace, interfere with
          the service, or misuse connected accounts. We may restrict access when needed to protect
          customers, comply with law, or address misuse.
        </p>

        <h2>Availability and changes</h2>
        <p>
          We work to keep Perceev available and secure, but do not promise uninterrupted service.
          Features may change as the product develops. We may update these terms; continued use
          after an update means you accept the revised terms.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms? Email <a href="mailto:vismayrathod29@gmail.com">vismayrathod29@gmail.com</a>.
        </p>
        <p className="legal-page__back"><Link href="/">Back to Perceev</Link></p>
      </main>
      <SiteFooter />
    </>
  );
}
