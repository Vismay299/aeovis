/**
 * F04 — the sign-in surface is an app route, so it carries the same
 * `notranslate` marker the portal does. The app shell itself lands on this
 * route in phase 6, which will add the providers here.
 */
export const metadata = { other: { google: "notranslate" } };

export default function LoginLayout({ children }) {
  return children;
}
