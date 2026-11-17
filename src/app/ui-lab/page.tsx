import { notFound } from "next/navigation";
import UiLab from "./UiLab";

export const metadata = { title: "UI lab | Perceev", robots: { index: false, follow: false } };

// A local review page for colour schemes and motion. Like the scheme dock, it
// exists in development and in a build only when NEXT_PUBLIC_PALETTE_REVIEW=1.
export default function UiLabPage() {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_PALETTE_REVIEW !== "1") {
    notFound();
  }
  return <UiLab />;
}
