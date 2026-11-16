/**
 * F04 — the sign-up surface is an app route, so it carries the shared app
 * providers and the same `notranslate` marker the portal does.
 */
import { AppProviders } from "@/components/app/providers/AppProviders";

export const metadata = { other: { google: "notranslate" } };

export default function SignupLayout({ children }) {
  return <AppProviders>{children}</AppProviders>;
}
