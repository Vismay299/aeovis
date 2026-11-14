export const dynamic = "force-dynamic";

import Link from "next/link";
import AuthLayout from "@/components/portal/AuthLayout";
import { Button } from "@/components/ui/button";
import { readEmailConfig } from "@/lib/email/config.ts";
import { verifyUnsubscribe } from "@/lib/email/links.ts";
import { firstParam } from "@/shared/auth-redirect";

export const metadata = {
  title: "Unsubscribe | Perceev",
  description: "Stop Perceev notification emails.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/email/unsubscribe" },
};

const CATEGORY_LABELS = {
  scan_results: "scan result",
  schedule_alerts: "scheduled-scan",
  spend_alerts: "spend-limit",
  product_updates: "product update",
};

export default async function EmailUnsubscribePage({ searchParams }) {
  const params = await searchParams;
  const u = firstParam(params?.u);
  const c = firstParam(params?.c);
  const t = firstParam(params?.t);
  const done = firstParam(params?.done);

  const label = CATEGORY_LABELS[c] ?? null;
  const valid =
    label !== null &&
    u !== "" &&
    t !== "" &&
    verifyUnsubscribe(readEmailConfig(), u, c, t);

  if (valid && done === "1") {
    return (
      <AuthLayout title="You're unsubscribed" titleId="unsubscribe-title">
        <p className="text-sm text-muted-foreground">
          You won&apos;t get {label} emails any more.
        </p>
        <p className="mt-4 text-sm">
          <Link
            href="/portal/settings/notifications"
            className="text-foreground underline underline-offset-2"
          >
            Email settings
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (valid) {
    return (
      <AuthLayout title={`Stop ${label} emails?`} titleId="unsubscribe-title">
        <p className="text-sm text-muted-foreground">
          We&apos;ll stop sending {label} emails to this account. You can turn
          them back on in Settings → Emails.
        </p>
        <form
          method="post"
          action="/api/customer/email/unsubscribe"
          className="mt-4"
        >
          <input type="hidden" name="u" value={u} />
          <input type="hidden" name="c" value={c} />
          <input type="hidden" name="t" value={t} />
          <Button type="submit" className="w-full font-semibold">
            Stop these emails
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="This link is not valid" titleId="unsubscribe-title">
      <p className="text-sm text-muted-foreground">
        Sign in to change your email settings.
      </p>
      <p className="mt-4 text-sm">
        <Link
          href="/login?next=/portal/settings/notifications"
          className="text-foreground underline underline-offset-2"
        >
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
