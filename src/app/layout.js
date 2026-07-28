import "./globals.css";
import "@/components/signal/signal.css";
import { Toaster } from "sonner";

export const metadata = {
  title: "Perceev | Answer Engine Intelligence",
  description: "AI is answering your buyers. Know which brand it clears the path to.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--panel-2)",
              border: "1px solid var(--rule-2)",
              borderRadius: "var(--radius-1)",
              color: "var(--text-1)",
              font: "var(--type-body-sm)",
              boxShadow: "var(--shadow-pop)",
            },
          }}
        />
      </body>
    </html>
  );
}
