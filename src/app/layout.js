import "./globals.css";
import "@/components/design-system/primitives.css";
import "@/components/portal/portal.css";
import SurfaceSync from "@/components/app/theme/SurfaceSync";
import AppToaster from "@/components/app/AppToaster";
import NavigationProgress from "@/components/app/motion/NavigationProgress";
import CardGlow from "@/components/app/motion/CardGlow";
import PaletteSwitcher from "@/components/app/theme/PaletteSwitcher";
import { buildThemeInitScript } from "@/shared/theme/theme";
import { BASE_PALETTE, BASE_SHAPE, buildPaletteInitScript } from "@/shared/theme/palette";

// The base scheme and shape are set on <html> for every visitor. The dock
// that tries variants of them is a local review tool: it shows in
// development, and in a build only when NEXT_PUBLIC_PALETTE_REVIEW=1.
const PALETTE_REVIEW =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_PALETTE_REVIEW === "1";

export const metadata = {
  metadataBase: new URL("https://perceev.com"),
  title: "Perceev | Answer Engine Intelligence",
  description:
    "AI is answering your buyers. Perceev asks the answer engines unbranded buyer questions and reports which brand each answer names.",
  alternates: {
    canonical: "/",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="light" data-palette={BASE_PALETTE} data-shape={BASE_SHAPE} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
        {PALETTE_REVIEW ? <script dangerouslySetInnerHTML={{ __html: buildPaletteInitScript() }} /> : null}
      </head>
      <body className="antialiased">
        <SurfaceSync />
        <NavigationProgress />
        <CardGlow />
        {children}
        <AppToaster />
        {PALETTE_REVIEW ? <PaletteSwitcher /> : null}
      </body>
    </html>
  );
}
