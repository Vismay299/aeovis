/**
 * F04 — operator pages sit outside the customer shell but share the app
 * providers (and therefore the app tokens). No sidebar, no metadata change.
 */
import { AppProviders } from "@/components/app/providers/AppProviders";

export default function OpsLayout({ children }) {
  return <AppProviders>{children}</AppProviders>;
}
