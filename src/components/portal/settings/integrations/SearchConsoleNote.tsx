import Link from "next/link";
import { CardShell } from "@/components/app/CardShell";

/** Search Console keeps its own page; this card only points there. */
export function SearchConsoleNote() {
  return (
    <CardShell title="Google Search Console">
      <p className="text-sm text-muted-foreground">
        Search Console is connected on its own page.{" "}
        <Link href="/portal/search-console" className="font-medium text-foreground underline underline-offset-4">
          Open Search Console
        </Link>
      </p>
    </CardShell>
  );
}
