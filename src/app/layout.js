import "./globals.css";
import { Toaster } from "sonner";

export const metadata = {
  title: "Perceev | Answer Engine Intelligence",
  description:
    "AI is answering your buyers. Perceev asks the answer engines unbranded buyer questions and reports which brand each answer names.",
};

/* The viewer has three theme states, not two: an explicit choice stamps
   data-theme on the root, and the default "system" setting stamps nothing —
   only prefers-color-scheme separates light from dark there. This runs
   before paint so a chosen theme never flashes the other one first. */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('perceev-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="antialiased">
        {children}
        <Toaster
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
