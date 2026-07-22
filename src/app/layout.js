import "./globals.css";
import { Toaster } from "sonner";

export const metadata = {
  title: "Perceev | Answer Engine Intelligence",
  description: "AI is answering your buyers. Know where you stand.",
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
