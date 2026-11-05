import { AppProviders } from "@/components/app/providers/AppProviders";
import PortalShell from "@/components/portal/PortalShell";

export const dynamic = "force-dynamic";

export const metadata = { other: { google: "notranslate" } };

export default function PortalLayout({ children }) {
  return (
    <AppProviders>
      <PortalShell>{children}</PortalShell>
    </AppProviders>
  );
}
