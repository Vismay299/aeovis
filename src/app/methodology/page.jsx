import Link from "next/link";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";

export const metadata = {
  title: "Measurement methodology | Perceev",
  description: "How Perceev samples buyer questions, records answer surfaces, handles collection failures and labels exploratory results.",
  alternates: { canonical: "/methodology" },
};

export default function MethodologyPage() {
  return <>
    <SiteNav />
    <main className="legal-page shell">
      <p className="tag tag--brand">Methodology</p>
      <h1>What an answer measurement means</h1>
      <p>Perceev observes answers to a defined set of buyer questions. Each report describes that sample, at its capture time, rather than every buyer or every answer an assistant might produce.</p>
      <h2>Questions and comparison</h2>
      <p>New tracked sets target 30 unbranded questions. Prompts are frozen for repeat observations; branded diagnostics are separate from scoring. Compare the same prompt and panel versions, surface, location, language and observation window. A changed question set or collection method can change a result without a change in brand performance.</p>
      <h2>Surfaces and locations</h2>
      <p>Google AI Overview collection uses a SERP provider. Other configured engines may use model APIs or gateways with search grounding. An API answer is not evidence of what a signed-in consumer sees. Consumer browser capture remains unqualified until separate validation is complete. Offered engines depend on deployment configuration; a configured engine is not proof of a successful capture. A requested location is not a verified location unless the capture supplies evidence.</p>
      <h2>Counts, failures and denominators</h2>
      <p>A valid Google result without an AI Overview counts as collected, but does not enter the conditional AI Overview answer denominator. Failed requests and observations never attempted are separate from valid observations; a failure is not evidence that the brand was absent. Mentions, citations and recommendations describe different evidence. First textual mention is not recommendation rank.</p>
      <p>The current measurement policy requires at least 95% valid collection and 20 distinct eligible prompt IDs in the actual metric denominator for an unqualified headline. Repeated captures do not create new distinct questions. Results below the applicable gate are exploratory or insufficient. Read the report’s actual counts, denominator, coverage and policy version; for historical reports, check the recorded policy and qualification rather than assuming current rules were applied.</p>
      <h2>Limits and product status</h2>
      <p>Answers vary across time, session, geography and provider. Small or correlated samples do not establish market-wide preference. A before-and-after association does not establish that publishing content caused a ranking change. Conventional Search Console metrics are not AI Overview-specific traffic or proof that a page is indexed.</p>
      <p>One successful capture does not establish repeatable collection quality. Longer-term performance claims require observations over a stated real period. We have not published a completed owned-site improvement study or a verified client outcome here.</p>
      <h2>Explore the workflow</h2>
      <p><Link href="/use-cases">Explore use cases</Link> · <Link href="/demo">Open the simulated workflow</Link> · <Link href="/scan">Start a scan</Link></p>
      <p>Demonstrations use invented answers and are labelled as simulations. They do not establish live collection quality or client results.</p>
    </main>
    <SiteFooter />
  </>;
}
