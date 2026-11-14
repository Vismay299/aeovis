import LegalPage, { LegalContact } from "@/components/legal/LegalPage";
import { POLICY_VERSION } from "@/lib/telemetry/events.ts";

export { POLICY_VERSION };
export const LAST_UPDATED = POLICY_VERSION;

export const metadata = {
  title: "Privacy Policy | Perceev",
  description: "How Perceev handles account, workspace, and Google Search Console data.",
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <LegalPage eyebrow="PRIVACY" title="Privacy Policy">
      <p className="legal-page__updated">Last updated: {POLICY_VERSION}</p>
      <p>
        This policy explains how Perceev handles information when you use the Perceev website,
        customer workspace, and related services. For privacy questions or a data deletion
        request, contact <LegalContact />.
      </p>

      <h2>Information we handle</h2>
      <p>
        We handle account details such as your name and email address, workspace and brand
        details you provide, and information needed to secure and operate your account. If you
        connect Google Search Console, we receive the Google property you select and read-only
        search performance data for that property, including dates, search queries, clicks,
        impressions, click-through rate, and average position.
      </p>

      <h2 id="google-sign-in">Signing in with Google</h2>
      <p>
        If you choose Continue with Google, Google shares your name, email address and Google account identifier with Perceev so we can create and secure your account. Perceev does not receive your Google password, and signing in with Google does not give Perceev access to your Search Console or Analytics data; those connections ask for separate permission.
      </p>

      <h2 id="google-search-console-data">Google Search Console data</h2>
      <p>
        Perceev requests the read-only Google Search Console permission
        (webmasters.readonly). We use it to confirm which properties your Google account can
        access, sync the property you select, and show its search performance in your Perceev
        workspace. We do not use this permission to change your Search Console settings or
        property data.
      </p>
      <p>
        OAuth access and refresh tokens are encrypted before they are stored on Perceev servers.
        Search performance records are stored with the workspace they belong to and are only
        returned to members authorized for that workspace. Disconnecting Search Console deletes
        the stored OAuth credentials and stops future synchronization. Previously synchronized
        reports remain in the workspace until you ask us to delete them or the workspace is
        deleted. You can also revoke Perceev’s access from your Google Account.
      </p>
      <p>
        We use Google user data only to provide the Search Console features described above. We
        do not sell it, use it for advertising, or send it to AI model providers for model input
        or training. We do not allow people to read it except when needed to provide support you
        request, protect the service, or meet legal obligations.
      </p>

      <h2 id="analytics">Product analytics and error reports</h2>
      <p>
        If you turn on usage analytics (it is off until you do), Perceev uses PostHog, hosted in
        the European Union, to record which pages and features of the customer workspace you use,
        linked to a random account identifier. We never record your questions, AI answers,
        website or Search Console data, keywords, or screen recordings, and we do not use
        analytics for advertising. You can turn it off at any time in Settings → Privacy. We also
        send error reports (the type of error and where in our code it happened, never its
        content) so we can fix problems; they are linked to your account only if you turned on
        usage analytics. We count a few anonymous events, such as an account being created,
        without linking them to anyone.
      </p>
      <p>
        When usage analytics is on, PostHog stores an identifier in your browser; a small Perceev
        cookie remembers your choice.
      </p>

      <h2>How information is used and shared</h2>
      <p>
        We use account and workspace information to provide Perceev, keep accounts secure,
        support customers, and improve the service. Perceev uses infrastructure providers for
        hosting, authentication, and database storage. These providers process information for
        Perceev to operate the service. When you use an AI content feature, the content or prompt
        you submit may be processed by the model provider configured for that feature; Google
        Search Console data is not sent to those providers.
      </p>
      <p>
        Sign-up, sign-in and password-reset forms use Cloudflare Turnstile to block automated abuse; Cloudflare processes technical information from your browser for this check.
      </p>
      <p>
        We may disclose information when necessary to protect the service, comply with law, or
        complete a business transfer after providing any notice required by law. We do not sell
        personal information.
      </p>
      <p>
        We use Loops to send account emails: notifications about your workspace (for example when
        a scan finishes), a short series of setup tips after you sign up, and product updates
        only if you opt in. Loops receives your email address, name if you provided one, and
        which setup steps you've completed — never your questions, AI answers or website
        data. Every notification email has a link to stop it, and you can change all email
        settings in Settings → Emails.
      </p>

      <h2>Retention and your choices</h2>
      <p>
        We keep account and workspace information while the workspace is active and as needed to
        operate, secure, and support Perceev. To disconnect Search Console, use the connection
        controls in your workspace. To request deletion of workspace information, email us from
        an address associated with the workspace. You may also revoke Google access in your
        Google Account settings.
      </p>

      <h2>Security and updates</h2>
      <p>
        We use access controls and encryption for stored Search Console credentials. No online
        service can guarantee absolute security. We may update this policy as Perceev changes;
        the date above shows when it was last revised.
      </p>
    </LegalPage>
  );
}
