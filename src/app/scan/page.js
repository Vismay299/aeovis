"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Wordmark } from "@/components/perceev/Wordmark";
import { Button } from "@/components/perceev/Button";
import { Input } from "@/components/perceev/Input";
import { Select } from "@/components/perceev/Select";
import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Alert } from "@/components/perceev/Alert";
import { Card } from "@/components/perceev/Card";
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
  const [customIndustry, setCustomIndustry] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [industries, setIndustries] = useState([]);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    fetchIndustries().then((data) => setIndustries(data.industries || [])).catch(() => {});
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
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const start = async () => {
    if (!validate()) return;

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
          industry: industry === "__custom__" ? customIndustry.trim() : industry,
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
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-0)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Slim top bar */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          background: "var(--bg-0)",
          borderBottom: "1px solid var(--border-1)",
          padding: "0 var(--space-6)",
          height: "56px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Link href="/" aria-label="Perceev home" style={{ display: "inline-flex" }}>
          <Wordmark size="sm" />
        </Link>
        <button
          onClick={() => {
            if (scanning) return;
            setBrand("");
            setWebsite("");
            setIndustry("");
            setCustomIndustry("");
            setCompetitors("");
            setErrors({});
          }}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "var(--text-3)",
            transition: "color var(--dur-fast)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-1)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-3)")}
        >
          New scan
        </button>
      </header>

      <div
        style={{
          maxWidth: "700px",
          margin: "0 auto",
          padding: "var(--space-10) var(--space-6)",
        }}
      >
        {!scanning ? (
          <div>
            <h1
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-h1)",
                fontWeight: 600,
                letterSpacing: "var(--track-h1)",
                color: "var(--text-1)",
                marginBottom: "var(--space-3)",
              }}
            >
              Run a visibility check
            </h1>
            <p
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-body-lg)",
                color: "var(--text-2)",
                marginBottom: "var(--space-8)",
                lineHeight: 1.6,
              }}
            >
              We probe how often AI answers surface your brand across the prompts your buyers
              actually ask.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
              <Input
                id="brand"
                data-testid="scan-brand-input"
                label="Brand or company name"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Acme Analytics"
                error={errors.brand}
              />

              <Input
                id="website"
                data-testid="scan-website-input"
                label="Website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="acme.com"
                error={errors.website}
              />

              <Select
                id="industry"
                data-testid="scan-industry-input"
                label={
                  <>
                    Industry{" "}
                    <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                      (optional — helps with fallback)
                    </span>
                  </>
                }
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              >
                <option value="">Select an industry...</option>
                {industries.map((ind) => (
                  <option key={ind.id} value={ind.id}>
                    {ind.label}
                  </option>
                ))}
                <option value="__custom__">Other — type your own…</option>
              </Select>

              {industry === "__custom__" && (
                <Input
                  id="custom-industry"
                  data-testid="scan-custom-industry-input"
                  label="Your industry"
                  value={customIndustry}
                  onChange={(e) => setCustomIndustry(e.target.value)}
                  placeholder="e.g. Dental equipment, Pet food, Drone services"
                />
              )}

              <Input
                id="competitors"
                data-testid="scan-competitors-input"
                label={
                  <>
                    Competitors{" "}
                    <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                      (optional — we also auto-discover co-mentions from AIOs)
                    </span>
                  </>
                }
                value={competitors}
                onChange={(e) => setCompetitors(e.target.value)}
                placeholder="e.g. Kajaria, Somany (optional)"
              />

              <p
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "13px",
                  color: "var(--text-2)",
                  borderLeft: "2px solid var(--border-2)",
                  paddingLeft: "var(--space-4)",
                  lineHeight: 1.55,
                }}
              >
                This scan probes Google&apos;s live AI Overview for every tracked query
                using Bright Data. Rivals are discovered from brands co-mentioned or
                cited in those answers (Blank-style), and any names you list here are
                always tracked too.
              </p>

              <Button
                data-testid="scan-submit-btn"
                variant="primary"
                size="lg"
                onClick={start}
                style={{ width: "100%" }}
              >
                Start scan
              </Button>
            </div>

            {/* Recent / sample scans */}
            <div style={{ marginTop: "var(--space-11)" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "var(--text-3)",
                }}
              >
                Recent scans
              </span>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "var(--space-3)",
                  marginTop: "var(--space-4)",
                }}
              >
                {RECENT.map((r, i) => (
                  <button
                    key={i}
                    data-testid={`recent-scan-${i}`}
                    onClick={() => {
                      saveScan({
                        ...SAMPLE_RESULT,
                        brand: r.brand,
                        website: r.site,
                        visibilityScore: r.score,
                        isSample: true,
                      });
                      router.push("/dashboard");
                    }}
                    style={{
                      textAlign: "left",
                      background: "var(--bg-1)",
                      border: "1px solid var(--border-1)",
                      borderRadius: "var(--radius-2)",
                      padding: "var(--space-5)",
                      cursor: "pointer",
                      transition: "border-color var(--dur-fast)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--accent-border)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border-1)";
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "var(--text-1)",
                      }}
                    >
                      {r.brand}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "10px",
                        color: "var(--text-3)",
                        marginBottom: "var(--space-4)",
                      }}
                    >
                      {r.site}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                      <span
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "28px",
                          fontWeight: 600,
                          color: "var(--accent)",
                          lineHeight: 1,
                        }}
                      >
                        {r.score}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "11px",
                          color: "var(--text-3)",
                        }}
                      >
                        /100
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div
            data-testid="scan-loading"
            style={{
              minHeight: "60vh",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                color: "var(--accent-text)",
              }}
            >
              Scanning
            </span>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-h1)",
                fontWeight: 600,
                letterSpacing: "var(--track-h1)",
                color: "var(--text-1)",
                marginTop: "var(--space-4)",
              }}
            >
              Analyzing {brand} ({progress}%)
              <span className="caret-blink" style={{ color: "var(--accent)" }}>
                _
              </span>
            </h2>
            <p
              style={{
                color: "var(--text-2)",
                marginTop: "var(--space-3)",
                marginBottom: "var(--space-8)",
                fontSize: "14px",
                lineHeight: 1.55,
              }}
            >
              Sourcing real Google queries, then probing Google AI Overview via Bright
              Data. This usually takes 60-90 seconds.
            </p>

            <div style={{ display: "flex", flexDirection: "column" }}>
              {STAGES.map((label, i) => {
                const done = i < stage;
                const active = i === stage;
                return (
                  <div
                    key={i}
                    data-testid={`scan-stage-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "var(--space-4)",
                      padding: "var(--space-4) 0",
                      borderBottom: "1px solid var(--border-1)",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "14px",
                        color: "var(--text-3)",
                        width: "28px",
                        flexShrink: 0,
                      }}
                    >
                      0{i + 1}
                    </span>
                    <span
                      style={{
                        fontSize: "16px",
                        transition: "color var(--dur-fast)",
                        color: active
                          ? "var(--text-1)"
                          : done
                          ? "var(--text-2)"
                          : "var(--text-3)",
                        fontWeight: active ? 500 : 400,
                      }}
                    >
                      {label}
                      {active && (
                        <span
                          className="caret-blink"
                          style={{ color: "var(--accent)" }}
                        >
                          {" "}…
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontFamily: "var(--font-mono)",
                        fontSize: "10px",
                        fontWeight: 500,
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        color: done
                          ? "var(--good)"
                          : active
                          ? "var(--accent-text)"
                          : "var(--text-3)",
                      }}
                    >
                      {done ? "Done" : active ? "Running" : "Queued"}
                    </span>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: "var(--space-8)" }}>
              <ScoreMeter segments={20} value={progress} />
            </div>
          </div>
        )}

        {failed && (
          <div style={{ marginTop: "var(--space-6)" }}>
            <Alert
              data-testid="scan-error-banner"
              variant="crit"
            >
              Something went wrong running the scan. Please try again.
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
