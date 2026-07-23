"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Card } from "@/components/perceev/Card";
import { Button } from "@/components/perceev/Button";
import { Input } from "@/components/perceev/Input";
import { Select } from "@/components/perceev/Select";

/**
 * "New content" form — brand, playbook, topic, brand-profile preset.
 * First (and v1 only) preset: healthcare-cxo.
 */
export function NewContentForm({ brand: initialBrand, onStarted }) {
  const [brand, setBrand] = useState(initialBrand || "");
  const [playbook, setPlaybook] = useState("linkedin_post");
  const [topic, setTopic] = useState("");
  const [preset, setPreset] = useState("healthcare-cxo");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!brand.trim()) {
      setError("Brand is required.");
      return;
    }
    if (!topic.trim()) {
      setError(
        playbook === "geo_article"
          ? "Topic / target query is required — or trigger from a scan gap in the Answers view."
          : "Topic is required."
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input =
        playbook === "geo_article"
          ? { type: "topic", query: topic.trim(), topic: topic.trim(), brand_profile: preset }
          : { type: "topic", topic: topic.trim(), brand_profile: preset };
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: brand.trim(), playbook, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to start content job");
      onStarted?.(data.job_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card style={{ padding: "var(--space-7)" }} data-testid="studio-new-form">
      <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "17px", fontWeight: 600, color: "var(--text-1)", marginBottom: "var(--space-2)" }}>
        New content
      </h3>
      <p style={{ fontSize: "13px", color: "var(--text-2)", marginBottom: "var(--space-6)", lineHeight: 1.6 }}>
        The pipeline runs coordinate → research → benchmark → draft → review, then queues the
        piece here for your approval. Nothing publishes without your click.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <Input
          id="studio-new-brand"
          data-testid="studio-new-brand"
          label="Brand"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="Brand name"
        />

        <Select
          id="studio-new-playbook"
          data-testid="studio-new-playbook"
          label="Playbook"
          value={playbook}
          onChange={(e) => setPlaybook(e.target.value)}
        >
          <option value="linkedin_post">LinkedIn post — CXO voice</option>
          <option value="geo_article">GEO article — win AI citations</option>
        </Select>

        <Input
          id="studio-new-topic"
          data-testid="studio-new-topic"
          label={playbook === "geo_article" ? "Topic / target query" : "Topic"}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={
            playbook === "geo_article"
              ? "e.g. cost of corporate health checkup packages"
              : "e.g. home-collection economics for diagnostics chains"
          }
        />

        <Select
          id="studio-new-preset"
          data-testid="studio-new-preset"
          label="Brand profile preset"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          <option value="healthcare-cxo">
            Healthcare CXO — hospitals / clinics / diagnostics / pharmacies
          </option>
        </Select>

        {error && <div style={{ fontSize: "12px", color: "var(--crit)" }}>{error}</div>}

        <div>
          <Button
            data-testid="studio-new-submit"
            variant="primary"
            size="md"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Sparkles size={14} />
            )}
            {submitting ? "Starting…" : "Generate"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
