"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, AlertCircle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Navbar } from "@/components/Navbar";
import { toast } from "sonner";
import { runScan, saveScan, fetchIndustries, loadScan, clearScan } from "@/services/api";
import { SAMPLE_RESULT } from "@/data/mockData";

const STAGES = [
  "Submitting brand for analysis",
  "Sourcing real Google queries (PAA + Autocomplete)",
  "Probing Google AI Overview via Bright Data",
  "Scoring visibility & composing evidence",
];

const RECENT = [
  { brand: "Brightwave", site: "brightwave.io", score: 71 },
  { brand: "NorthPeak", site: "northpeak.com", score: 52 },
  { brand: "Lumen IQ", site: "lumeniq.ai", score: 38 },
];

export default function Scan() {
  const router = useRouter();
  const [brand, setBrand] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [industries, setIndustries] = useState([]);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    fetchIndustries().then(data => setIndustries(data.industries || [])).catch(() => {});
  }, []);
  const [scanning, setScanning] = useState(false);
  const [stage, setStage] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const validate = () => {
    const e = {};
    if (!brand.trim()) e.brand = "Brand name is required.";
    if (!website.trim()) e.website = "Website is required.";
    else if (!/^([\w-]+\.)+[\w-]{2,}.*$/.test(website.replace(/^https?:\/\//, "")))
      e.website = "Enter a valid domain, e.g. acme.com";
    // Industry is optional now — dynamic prompt generation works without it
    // (it helps with fallback and categorization)
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const start = async () => {
    if (!validate()) return;

    // If starting a scan for a *different* brand/website than the last saved result,
    // clear the old data first. This prevents the dashboard from showing
    // prompts/results from a previous run (e.g. Monoedge) when viewing the new brand.
    try {
      const current = loadScan();
      const newBrand = brand.trim();
      const newWebsite = website.trim();
      if (current && (current.brand !== newBrand || current.website !== newWebsite)) {
        clearScan();
      }
    } catch {}

    setScanning(true);
    setFailed(false);
    setStage(0);
    setProgress(0);
    try {
      const result = await runScan(
        { 
          brand: brand.trim(), 
          website: website.trim(), 
          industry, 
          competitors: competitors.trim(),
        },
        (s, p) => {
          setStage(s);
          if (p !== undefined) {
            setProgress(p);
          } else {
            setProgress(Math.round(((s + 1) / STAGES.length) * 100));
          }
        }
      );
      saveScan(result);
      toast.success("Scan complete");
      router.push("/dashboard");
    } catch (err) {
      setFailed(true);
      setScanning(false);
      toast.error(err?.message || "Scan failed. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7]">
      <Navbar />
      <div className="max-w-3xl mx-auto px-6 md:px-12 py-16 md:py-24">
        <AnimatePresence mode="wait">
          {!scanning ? (
            <motion.div
              key="form"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5 }}
            >
              <div className="flex items-center gap-3 mb-6">
                <span className="h-px w-10 bg-[#D9531E]" />
                <span className="text-xs uppercase tracking-[0.2em] text-[#666666] font-medium">
                  New scan
                </span>
              </div>
              <h1 className="font-serif text-5xl md:text-6xl font-semibold tracking-tight text-[#1A1A1A] leading-[1.05]">
                Run a visibility check
              </h1>
              <p className="mt-6 text-lg text-[#666666] max-w-xl leading-relaxed">
                We probe how often AI answers surface your brand across the prompts your buyers
                actually ask.
              </p>

              <div className="mt-12 space-y-8">
                <div>
                  <label htmlFor="brand" className="block text-xs uppercase tracking-[0.15em] text-[#666666] font-medium mb-3">
                    Brand or company name
                  </label>
                  <input
                    id="brand"
                    data-testid="scan-brand-input"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Acme Analytics"
                    className="w-full bg-white border border-[#E5E2D9] focus:border-[#1A1A1A] focus:ring-1 focus:ring-[#1A1A1A] outline-none rounded-sm px-5 py-4 font-sans text-[#1A1A1A] placeholder:text-[#BBBBBB] transition-all"
                  />
                  {errors.brand && (
                    <p data-testid="scan-brand-error" className="mt-2 text-xs text-[#8B3A3A] flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" /> {errors.brand}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="website" className="block text-xs uppercase tracking-[0.15em] text-[#666666] font-medium mb-3">
                    Website
                  </label>
                  <input
                    id="website"
                    data-testid="scan-website-input"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="acme.com"
                    className="w-full bg-white border border-[#E5E2D9] focus:border-[#1A1A1A] focus:ring-1 focus:ring-[#1A1A1A] outline-none rounded-sm px-5 py-4 font-sans text-[#1A1A1A] placeholder:text-[#BBBBBB] transition-all"
                  />
                  {errors.website && (
                    <p data-testid="scan-website-error" className="mt-2 text-xs text-[#8B3A3A] flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" /> {errors.website}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="industry" className="block text-xs uppercase tracking-[0.15em] text-[#666666] font-medium mb-3">
                    Industry <span className="text-[#999999] font-normal">(optional — helps with fallback)</span>
                  </label>
                  <Select value={industry} onValueChange={setIndustry}>
                    <SelectTrigger
                      id="industry"
                      data-testid="scan-industry-input"
                      className="w-full bg-white border border-[#E5E2D9] focus:border-[#1A1A1A] focus:ring-1 focus:ring-[#1A1A1A] outline-none rounded-sm px-5 py-4 font-sans text-[#1A1A1A] transition-all h-auto"
                    >
                      <SelectValue placeholder="Select an industry..." />
                    </SelectTrigger>
                    <SelectContent>
                      {industries.map((ind) => (
                        <SelectItem key={ind.id} value={ind.id}>
                          {ind.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.industry && (
                    <p data-testid="scan-industry-error" className="mt-2 text-xs text-[#8B3A3A] flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" /> {errors.industry}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="competitors" className="block text-xs uppercase tracking-[0.15em] text-[#666666] font-medium mb-3">
                    Competitors <span className="text-[#999999] font-normal">(comma-separated, max 4)</span>
                  </label>
                  <input
                    id="competitors"
                    data-testid="scan-competitors-input"
                    value={competitors}
                    onChange={(e) => setCompetitors(e.target.value)}
                    placeholder="Rival A, Rival B"
                    className="w-full bg-white border border-[#E5E2D9] focus:border-[#1A1A1A] focus:ring-1 focus:ring-[#1A1A1A] outline-none rounded-sm px-5 py-4 font-sans text-[#1A1A1A] placeholder:text-[#BBBBBB] transition-all"
                  />
                </div>

                <p className="text-sm text-[#666666] border-l-2 border-[#E5E2D9] pl-4 leading-relaxed">
                  This scan probes Google&apos;s live AI Overview for every tracked query
                  using Bright Data&apos;s SERP API. We seed the queries from real Google
                  People-Also-Ask and autocomplete for your category, so branded searches
                  don&apos;t artificially inflate your visibility.
                </p>

                <button
                  data-testid="scan-submit-btn"
                  onClick={start}
                  className="group w-full inline-flex items-center justify-center gap-2 bg-[#D9531E] text-white hover:bg-[#B34115] transition-colors rounded-sm px-8 py-5 font-sans font-semibold text-sm uppercase tracking-[0.12em]"
                >
                  Start scan
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" strokeWidth={2} />
                </button>
              </div>

              {/* Recent / sample scans */}
              <div className="mt-16">
                <span className="text-xs uppercase tracking-[0.15em] text-[#666666] font-medium">
                  Recent scans
                </span>
                <div className="mt-5 grid sm:grid-cols-3 gap-px bg-[#E5E2D9] border border-[#E5E2D9] rounded-sm overflow-hidden">
                  {RECENT.map((r, i) => (
                    <button
                      key={i}
                      data-testid={`recent-scan-${i}`}
                      onClick={() => {
                        saveScan({ ...SAMPLE_RESULT, brand: r.brand, website: r.site, visibilityScore: r.score, isSample: true });
                        router.push("/dashboard");
                      }}
                      className="text-left bg-white p-5 hover:bg-[#FDFBF7] transition-colors"
                    >
                      <div className="font-semibold text-[#1A1A1A] text-sm">{r.brand}</div>
                      <div className="text-xs text-[#999999] mb-4">{r.site}</div>
                      <div className="flex items-baseline gap-1">
                        <span className="font-serif text-3xl font-semibold text-[#D9531E] leading-none">
                          {r.score}
                        </span>
                        <span className="text-xs text-[#999999]">/100</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="loading"
              data-testid="scan-loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="min-h-[60vh] flex flex-col justify-center"
            >
              <span className="text-xs uppercase tracking-[0.2em] text-[#D9531E] font-semibold">
                Scanning
              </span>
              <h2 className="font-serif text-4xl md:text-5xl font-semibold tracking-tight text-[#1A1A1A] mt-4">
                Analyzing {brand} ({progress}%)
                <span className="caret-blink text-[#D9531E]">_</span>
              </h2>
              <p className="text-[#666666] mt-3 mb-12">Sourcing real Google queries, then probing Google AI Overview via Bright Data. This usually takes 60-90 seconds.</p>

              <div className="space-y-px">
                {STAGES.map((label, i) => {
                  const done = i < stage;
                  const active = i === stage;
                  return (
                    <div
                      key={i}
                      data-testid={`scan-stage-${i}`}
                      className="flex items-baseline gap-4 py-4 border-b border-[#E5E2D9]"
                    >
                      <span className="font-serif text-xl text-[#999999] w-8 shrink-0">
                        0{i + 1}
                      </span>
                      <span
                        className={`text-lg transition-colors ${
                          active
                            ? "text-[#1A1A1A] font-medium"
                            : done
                            ? "text-[#666666]"
                            : "text-[#CCCCCC]"
                        }`}
                      >
                        {label}
                        {active && <span className="caret-blink text-[#D9531E]"> …</span>}
                      </span>
                      <span className="ml-auto text-xs uppercase tracking-[0.15em] font-medium">
                        {done ? (
                          <span className="text-[#2F5C4F]">Done</span>
                        ) : active ? (
                          <span className="text-[#D9531E]">Running</span>
                        ) : (
                          <span className="text-[#CCCCCC]">Queued</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-10 h-px bg-[#E5E2D9] relative">
                <motion.div
                  className="absolute left-0 top-0 h-px bg-[#D9531E]"
                  initial={{ width: "0%" }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5 }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {failed && (
          <div
            data-testid="scan-error-banner"
            className="mt-8 flex items-center gap-3 bg-[#F9ECEC] border border-[#E2B8B8] rounded-sm px-5 py-4"
          >
            <AlertCircle className="w-5 h-5 text-[#8B3A3A] shrink-0" strokeWidth={1.5} />
            <span className="text-sm text-[#8B3A3A]">
              Something went wrong running the scan. Please try again.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
