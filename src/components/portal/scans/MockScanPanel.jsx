"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { Banner, Button, Card, Stat } from "../ui";
import { engineLabel } from "./reportData";

/** Same isolated scan/report workflow in the public demo and customer workspace. */
export default function MockScanPanel({ brandKey, brandName = "Italica", onUnauthorized }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  async function run() {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch(brandKey ? "/api/customer/scan/mock" : "/api/demo/scan", {
        method: "POST", signal: controller.signal,
        ...(brandKey ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brand_key: brandKey }) } : {}),
      });
      if (response.status === 401) { onUnauthorized?.(); return; }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Mock scan failed");
      setResult(body);
    } catch (err) { if (err.name !== "AbortError") setError(err.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return (
    <Card
      title="Run a mock scan"
      description={`Test the scan and report workflow for ${brandName}.`}
      actions={<Button variant="secondary" onClick={run} loading={busy} icon={Play}>Run mock scan</Button>}
    >
      <div className="space-y-4">
        <Banner title="Simulation only">
          30 example questions across Google AI Overviews, ChatGPT, Gemini and Perplexity. Answers and citations are invented fixtures, not a measurement of {brandName}. No provider calls, credits or saved scan history.
        </Banner>
        {error ? <Banner tone="error">{error}</Banner> : null}
        {result ? (
          <section aria-label="Mock scan results" className="space-y-4 pt-2">
            <Banner tone="success" title="Mock scan complete">
              {result.prompt_count} example questions · {result.answer_count} simulated answers · 4 engines
            </Banner>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Object.entries(result.scan.engines || {}).map(([key, engine]) => (
                <Stat
                  key={key}
                  label={engineLabel(key)}
                  value={engine.share_of_ai_pct ?? engine.visibility_pct}
                  suffix="%"
                  sub="Simulated visibility"
                />
              ))}
            </div>
            <details className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                View simulated answers and citations
              </summary>
              <div className="mt-3 divide-y divide-border">
                {result.results.map((row) => (
                  <article key={row.id} className="py-2.5 first:pt-0 last:pb-0 text-sm">
                    <p className="font-medium text-foreground">
                      {engineLabel(row.engine)} · {row.query}
                    </p>
                    <p className="mt-1 text-muted-foreground">{row.raw.text}</p>
                    {row.raw.references?.map((ref) => (
                      <p key={ref.href} className="text-xs text-muted-foreground">
                        Simulated citation: {ref.href}
                      </p>
                    ))}
                  </article>
                ))}
              </div>
            </details>
          </section>
        ) : null}
      </div>
    </Card>
  );
}
