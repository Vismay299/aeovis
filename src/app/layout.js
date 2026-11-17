import "./globals.css";
import "@/components/design-system/primitives.css";
import "@/components/portal/portal.css";
import SurfaceSync from "@/components/app/theme/SurfaceSync";
import AppToaster from "@/components/app/AppToaster";
import { buildThemeInitScript } from "@/shared/theme/theme";

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
    <html lang="en" data-theme="light" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
      </head>
      <body className="antialiased">
        <SurfaceSync />
        {children}
        <AppToaster />
      </body>
    </html>
  );
}
