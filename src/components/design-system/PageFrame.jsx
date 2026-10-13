import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";

/** Public product pages share website navigation and workspace primitives. */
export function PageFrame({ children }) {
  return <>
    <SiteNav />
    <main className="shell shell--wide pv-page public-workspace">{children}</main>
    <SiteFooter />
  </>;
}
