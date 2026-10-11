import "@/components/portal/portal.css";
import PortalShell from "@/components/portal/PortalShell";

export const dynamic = "force-dynamic";

export default function PortalLayout({ children }) {
  return <PortalShell>{children}</PortalShell>;
}
