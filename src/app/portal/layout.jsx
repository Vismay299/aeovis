import { cookies } from "next/headers";
import { AppProviders } from "@/components/app/providers/AppProviders";
import PortalShell from "@/components/portal/PortalShell";
import { SAMPLE_COOKIE } from "@/shared/sample/mode";

export const dynamic = "force-dynamic";

export const metadata = { other: { google: "notranslate" } };

export default async function PortalLayout({ children }) {
  // The sample workspace (src/shared/sample/mode.js) is decided on the server
  // from its cookie, so the first paint and hydration agree on the mode.
  const sample = (await cookies()).get(SAMPLE_COOKIE)?.value === "1";
  return (
    <AppProviders>
      <PortalShell sample={sample}>{children}</PortalShell>
    </AppProviders>
  );
}
