import "./globals.css";
import "@/components/design-system/primitives.css";
import "@/components/portal/portal.css";
import { Toaster } from "sonner";

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
    <html lang="en" data-theme="light" data-scroll-behavior="smooth">
      <body className="antialiased">
        {children}
        <Toaster
          theme="light"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-md)",
              color: "var(--ink-1)",
              fontFamily: "var(--font-sans)",
              fontSize: "14px",
              boxShadow: "var(--shadow-2)",
            },
          }}
        />
      </body>
    </html>
  );
}
