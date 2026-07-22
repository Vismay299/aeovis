"use client";

import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Button } from "@/components/perceev/Button";
import { Badge } from "@/components/perceev/Badge";
import { AnswerDemo } from "./AnswerDemo";
import { VerdictModule } from "./VerdictModule";
import { ScanBar } from "./ScanBar";
import { saveScan } from "@/services/api";
import { SAMPLE_RESULT } from "@/data/mockData";

export const DossierModules = ({ onModuleInView }) => {
  const router = useRouter();

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push("/dashboard");
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-11)",
        paddingTop: "var(--space-11)",
        paddingBottom: "var(--space-11)",
      }}
    >
      {/* Module 01 — The shift */}
      <section
        id="module-01"
        style={{
          paddingLeft: "88px",
          paddingRight: "var(--space-8)",
        }}
      >
        <div style={{ maxWidth: "600px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--accent-text)",
            }}
          >
            01 · The shift
          </span>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h1)",
              fontWeight: 600,
              letterSpacing: "var(--track-h1)",
              color: "var(--text-1)",
              marginTop: "var(--space-4)",
              marginBottom: "var(--space-5)",
            }}
          >
            Buyers don't click links anymore — they ask AI
          </h2>
          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-body-lg)",
              lineHeight: 1.6,
              color: "var(--text-2)",
            }}
          >
            Google's AI Overview, ChatGPT, and Perplexity now answer buyer questions
            directly — often without sending anyone to a website. Brands that don't appear
            in those answers are invisible to the next generation of search.
          </p>
        </div>
      </section>

      {/* Divider */}
      <div
        style={{
          height: "1px",
          background: "var(--border-1)",
          margin: "0 88px 0 88px",
        }}
      />

      {/* Module 02 — The answer */}
      <section
        id="module-02"
        style={{
          paddingLeft: "88px",
          paddingRight: "var(--space-8)",
        }}
      >
        <div style={{ maxWidth: "600px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--accent-text)",
            }}
          >
            02 · The answer
          </span>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h1)",
              fontWeight: 600,
              letterSpacing: "var(--track-h1)",
              color: "var(--text-1)",
              marginTop: "var(--space-4)",
              marginBottom: "var(--space-5)",
            }}
          >
            This is what AI tells your buyers
          </h2>
          <div
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--radius-2)",
              padding: "var(--space-7)",
              marginBottom: "var(--space-6)",
              minHeight: "120px",
            }}
          >
            <AnswerDemo />
          </div>
          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "14px",
              color: "var(--text-3)",
            }}
          >
            Probes cycle through real scenarios. Your brand highlighted in green, rivals in red.
          </p>
        </div>
      </section>

      {/* Divider */}
      <div
        style={{
          height: "1px",
          background: "var(--border-1)",
          margin: "0 88px 0 88px",
        }}
      />

      {/* Module 03 — A verdict */}
      <section
        id="module-03"
        style={{
          paddingLeft: "88px",
          paddingRight: "var(--space-8)",
        }}
      >
        <VerdictModule />
      </section>

      {/* Divider */}
      <div
        style={{
          height: "1px",
          background: "var(--border-1)",
          margin: "0 88px 0 88px",
        }}
      />

      {/* Module 04 — The rivalry */}
      <section
        id="module-04"
        style={{
          paddingLeft: "88px",
          paddingRight: "var(--space-8)",
        }}
      >
        <div style={{ maxWidth: "600px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--accent-text)",
            }}
          >
            04 · The rivalry
          </span>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h1)",
              fontWeight: 600,
              letterSpacing: "var(--track-h1)",
              color: "var(--text-1)",
              marginTop: "var(--space-4)",
              marginBottom: "var(--space-6)",
            }}
          >
            Your rivals are already there
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {[
              { name: "NorthPeak", score: 71, gap: "+7" },
              { name: "Lumen IQ", score: 58, gap: "-6" },
              { name: "Brightwave", score: 38, gap: "-26" },
            ].map((rival) => (
              <div
                key={rival.name}
                style={{
                  background: "var(--bg-1)",
                  border: "1px solid var(--border-1)",
                  borderRadius: "var(--radius-2)",
                  padding: "var(--space-5)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span
                      style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: "17px",
                        fontWeight: 600,
                        color: "var(--text-1)",
                      }}
                    >
                      {rival.name}
                    </span>
                    <Badge
                      variant={parseFloat(rival.gap) > 0 ? "weak" : "strong"}
                    >
                      {parseFloat(rival.gap) > 0 ? `+${rival.gap}` : rival.gap}
                    </Badge>
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: "24px",
                      fontWeight: 600,
                      color: "var(--accent-text)",
                    }}
                  >
                    {rival.score}
                  </span>
                </div>
                <ScoreMeter segments={30} value={rival.score} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Divider */}
      <div
        style={{
          height: "1px",
          background: "var(--border-1)",
          margin: "0 88px 0 88px",
        }}
      />

      {/* Module 05 — Begin */}
      <section
        id="module-05"
        style={{
          paddingLeft: "88px",
          paddingRight: "var(--space-8)",
        }}
      >
        <div style={{ maxWidth: "600px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--accent-text)",
            }}
          >
            05 · Begin
          </span>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h1)",
              fontWeight: 600,
              letterSpacing: "var(--track-h1)",
              color: "var(--text-1)",
              marginTop: "var(--space-4)",
              marginBottom: "var(--space-5)",
            }}
          >
            Start your first scan
          </h2>
          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-body-lg)",
              color: "var(--text-2)",
              marginBottom: "var(--space-7)",
            }}
          >
            Run a visibility check in under a minute. No signup. No credit card. Just
            your domain and we'll probe the rest.
          </p>
          <div style={{ marginBottom: "var(--space-6)" }}>
            <ScanBar />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4)",
            }}
          >
            <button
              data-testid="preview-sample-cta"
              onClick={viewSample}
              style={{
                background: "none",
                border: "none",
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--accent-text)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              See a sample report
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{
          paddingLeft: "88px",
          paddingRight: "var(--space-8)",
          paddingTop: "var(--space-8)",
          borderTop: "1px solid var(--border-1)",
          marginTop: "var(--space-11)",
        }}
        data-testid="footer"
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-6)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              color: "var(--text-3)",
              lineHeight: 1.6,
            }}
          >
            © {new Date().getFullYear()} Perceev. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};
