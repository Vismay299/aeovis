import Link from "next/link";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";

export const metadata = {
  title: "Answer research and content workflows | Perceev",
  description: "Use observed answers to review brand coverage, inspect cited sources and prepare content for human review, with explicit measurement limits.",
  alternates: { canonical: "/use-cases" },
};

export default function UseCasesPage() {
  return <>
    <SiteNav />
    <main className="legal-page shell">
      <p className="tag tag--brand">Use cases</p>
      <h1>Turn observed answers into reviewable work</h1>
      <h2>Review brand coverage</h2>
      <p>Inspect which measured answers mention or cite a brand, alongside failed captures and the actual question denominator. An exploratory observation can guide investigation without supporting a broad ranking claim.</p>
      <h2>Inspect sources</h2>
      <p>Follow citations to the evidence behind an answer. A citation suggests a source to investigate; it does not prove that editing that source will improve future answers.</p>
      <h2>Prepare content for review</h2>
      <p>Use the Content Studio workflow to prepare drafts for human review. Drafting, approving, publishing and observing a later answer are separate steps. A completed draft is not a verified publication or a measured improvement.</p>
      <h2>Compare compatible observations</h2>
      <p>Keep question versions, surface, location and observation windows aligned. Inspect coverage and uncertainty before interpreting movement; a later observation alone does not establish causality.</p>
      <p><Link href="/methodology">Read the measurement methodology</Link> · <Link href="/demo">Explore the simulated workflow</Link> · <Link href="/scan">Start a scan</Link></p>
      <p>These are product workflows, not client testimonials or promised outcomes. The demo uses invented fixtures.</p>
    </main>
    <SiteFooter />
  </>;
}
