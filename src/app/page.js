"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowUpRight, ArrowRight } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { DashboardPreview } from "@/components/DashboardPreview";
import { saveScan } from "@/services/api";
import { SAMPLE_RESULT } from "@/data/mockData";

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
};

export default function Landing() {
  const router = useRouter();

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push("/dashboard");
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7]">
      <Navbar />

      {/* Hero — asymmetric editorial */}
      <section className="max-w-7xl mx-auto px-6 md:px-12 pt-16 md:pt-24 pb-16 md:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-end">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-7"
          >
            <div className="flex items-center gap-3 mb-7">
              <span className="h-px w-10 bg-[#D9531E]" />
              <span className="text-xs uppercase tracking-[0.2em] text-[#666666] font-medium">
                Answer Engine Optimization
              </span>
            </div>
            <h1 className="font-serif text-5xl md:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.04] text-[#1A1A1A]">
              When AI answers,
              <br />
              does it name <span className="italic text-[#D9531E]">you</span>
              <br />
              — or your rival?
            </h1>
            <p className="mt-8 text-lg text-[#666666] max-w-xl leading-relaxed">
              Brands are quietly losing presence in AI-generated answers. AnswerRank measures
              exactly where you appear, where competitors win, and what to fix — in one clear report.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4">
              <button
                data-testid="hero-primary-cta"
                onClick={() => router.push("/scan")}
                className="group inline-flex items-center justify-center gap-2 bg-[#D9531E] text-white hover:bg-[#B34115] transition-colors rounded-sm px-8 py-4 font-sans font-semibold text-sm uppercase tracking-[0.1em]"
              >
                Run a visibility check
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" strokeWidth={2} />
              </button>
              <button
                data-testid="hero-secondary-cta"
                onClick={viewSample}
                className="inline-flex items-center justify-center gap-2 bg-transparent text-[#1A1A1A] border border-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-colors rounded-sm px-8 py-4 font-sans font-semibold text-sm uppercase tracking-[0.1em]"
              >
                See a sample report
              </button>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-5"
          >
            <DashboardPreview />
          </motion.div>
        </div>
      </section>

      {/* Value strip — editorial numbered */}
      <section className="border-y border-[#E5E2D9] bg-[#F3F0E6]">
        <div className="max-w-7xl mx-auto px-6 md:px-12 grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#E5E2D9]">
          {[
            { n: "01", t: "Visibility Score", d: "One honest number for your answer-engine presence." },
            { n: "02", t: "Top Prompts", d: "See exactly which queries surface your brand — and where." },
            { n: "03", t: "Competitor Gaps", d: "Spot the prompts where rivals appear and you don't." },
          ].map((item, i) => (
            <motion.div key={i} {...fadeUp} transition={{ duration: 0.5, delay: i * 0.1 }} className="py-10 md:py-12 md:px-10 first:md:pl-0 last:md:pr-0">
              <span className="font-serif text-3xl text-[#D9531E] font-semibold">{item.n}</span>
              <h3 className="font-sans text-lg font-semibold text-[#1A1A1A] mt-3">{item.t}</h3>
              <p className="text-sm text-[#666666] mt-1.5 leading-relaxed">{item.d}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="max-w-7xl mx-auto px-6 md:px-12 py-20 md:py-32">
        <motion.div {...fadeUp} className="max-w-2xl mb-16">
          <span className="text-xs uppercase tracking-[0.2em] text-[#D9531E] font-semibold">
            The method
          </span>
          <h2 className="font-serif text-4xl md:text-5xl font-semibold tracking-tight text-[#1A1A1A] mt-4 leading-tight">
            Three steps to a clear answer
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[#E5E2D9] border border-[#E5E2D9] rounded-sm overflow-hidden">
          {[
            { step: "Step 1", title: "Enter brand & site", desc: "Tell us the brand and website you want measured across AI answers." },
            { step: "Step 2", title: "AI runs the checks", desc: "Our engine probes dozens of real prompts your buyers actually ask." },
            { step: "Step 3", title: "Review visibility", desc: "Get a clear score, your top prompts, and where competitors are winning." },
          ].map((s, i) => (
            <motion.div
              key={i}
              {...fadeUp}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="bg-white p-8 md:p-10 hover:bg-[#FDFBF7] transition-colors"
            >
              <span className="text-xs uppercase tracking-[0.15em] text-[#999999] font-medium">{s.step}</span>
              <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] mt-4 mb-3">{s.title}</h3>
              <p className="text-sm text-[#666666] leading-relaxed">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Preview / The report */}
      <section id="preview" className="border-t border-[#E5E2D9] bg-[#F3F0E6]">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-20 md:py-32 grid lg:grid-cols-12 gap-12 items-center">
          <motion.div {...fadeUp} className="lg:col-span-5">
            <span className="text-xs uppercase tracking-[0.2em] text-[#D9531E] font-semibold">
              The report
            </span>
            <h2 className="font-serif text-4xl md:text-5xl font-semibold tracking-tight text-[#1A1A1A] mt-4 leading-tight">
              A dashboard built for decisions
            </h2>
            <p className="mt-6 text-[#666666] leading-relaxed">
              No clutter, no vanity charts. Just the metrics that tell you whether AI answers
              recommend you — or your competitors.
            </p>
            <ul className="mt-8 space-y-4">
              {[
                "AI Visibility Score with plain-language interpretation",
                "Top prompts ranked by where you appear",
                "Competitor co-mentions with explicit gap flags",
              ].map((t, i) => (
                <li key={i} className="flex items-start gap-3 text-[15px] text-[#1A1A1A]">
                  <span className="mt-2 w-1.5 h-1.5 bg-[#D9531E] shrink-0" />
                  {t}
                </li>
              ))}
            </ul>
            <button
              data-testid="preview-sample-cta"
              onClick={viewSample}
              className="group mt-9 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.1em] text-[#1A1A1A] border-b-2 border-[#D9531E] pb-1 hover:gap-3 transition-all"
            >
              Open the sample report
              <ArrowUpRight className="w-4 h-4 text-[#D9531E]" strokeWidth={2} />
            </button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7 }}
            className="lg:col-span-7"
          >
            <DashboardPreview />
          </motion.div>
        </div>
      </section>

      {/* Use cases */}
      <section id="usecases" className="max-w-7xl mx-auto px-6 md:px-12 py-20 md:py-32">
        <motion.div {...fadeUp} className="max-w-2xl mb-16">
          <span className="text-xs uppercase tracking-[0.2em] text-[#D9531E] font-semibold">
            Who it's for
          </span>
          <h2 className="font-serif text-4xl md:text-5xl font-semibold tracking-tight text-[#1A1A1A] mt-4 leading-tight">
            Built for teams that live in search
          </h2>
        </motion.div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            { idx: "For brands", title: "Protect your share of the answer", desc: "Understand whether AI recommends you, and defend the conversations that drive demand." },
            { idx: "For agencies", title: "Prove AEO impact to clients", desc: "Audit AI visibility for clients and hand over a clean, credible, editorial-grade report." },
            { idx: "For consultants", title: "Add AEO to your offering", desc: "Bring answer-engine optimization into your SEO and growth practice instantly." },
          ].map((u, i) => (
            <motion.div
              key={i}
              {...fadeUp}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="bg-white border border-[#E5E2D9] rounded-sm p-8 hover:border-[#1A1A1A] transition-colors"
            >
              <span className="text-xs uppercase tracking-[0.15em] text-[#D9531E] font-semibold">{u.idx}</span>
              <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] mt-4 mb-3 leading-snug">{u.title}</h3>
              <p className="text-sm text-[#666666] leading-relaxed">{u.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-[#E5E2D9] bg-[#1A1A1A]">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-24 md:py-32 text-center">
          <motion.div {...fadeUp}>
            <h2 className="font-serif text-5xl md:text-7xl font-semibold tracking-tight text-[#FDFBF7] leading-[1.05]">
              See where you stand
              <br />
              in AI answers.
            </h2>
            <p className="mt-6 text-lg text-[#A8A8A8] max-w-xl mx-auto">
              Run your first visibility check in under a minute. No signup required.
            </p>
            <button
              data-testid="final-cta"
              onClick={() => router.push("/scan")}
              className="group mt-10 inline-flex items-center gap-2 bg-[#D9531E] text-white hover:bg-[#B34115] transition-colors rounded-sm px-9 py-4 font-sans font-semibold text-sm uppercase tracking-[0.1em]"
            >
              Run a visibility check
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" strokeWidth={2} />
            </button>
          </motion.div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
