import "./globals.css";
import { Toaster } from "sonner";

export const metadata = {
  title: "AnswerRank | AEO Checker",
  description: "Check if AI knows your brand",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
