import { PageLoader } from "@/components/app/brand/PerceevLogo";

// The settings group has its own layout (header + tabs), so it needs its own
// suspense fallback; the portal-level one only covers the root segment.
export default function SettingsLoading() {
  return <PageLoader />;
}
