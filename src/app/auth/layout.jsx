/**
 * F04 — the auth sub-routes (forgot, verify, error, reset, accept) are app
 * routes, so they carry the shared app providers and the same `notranslate`
 * marker the portal does.
 */
import { AppProviders } from "@/components/app/providers/AppProviders";

export const metadata = { other: { google: "notranslate" } };

export default function AuthLayout({ children }) {
  return <AppProviders>{children}</AppProviders>;
}
