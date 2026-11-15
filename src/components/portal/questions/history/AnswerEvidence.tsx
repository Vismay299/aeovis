"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/AnswerContent.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import React, { useState } from "react";
import { Globe } from "lucide-react";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { MarkdownAnswer } from "@/components/app/markdown/MarkdownAnswer";
import { excerpt } from "@/shared/question-history";
import { MentionBadge } from "./MentionBadge";
import type { AnswerDetail } from "./hooks/useQuestionHistory";

export function AnswerEvidence({
  answer,
  askedText,
  currentQuestionText,
}: {
  answer: AnswerDetail;
  askedText?: string;
  currentQuestionText?: string;
}) {
  const [mobileTab, setMobileTab] = useState<"answer" | "citations" | "brands">("answer");
  const [evidenceTab, setEvidenceTab] = useState<"citations" | "brands">("citations");

  const execution = answer.execution;
  const isAnswered = execution.status === "answered";
  const citations = answer.citations ?? [];
  const brands = answer.brands ?? [];
  const displayText = answer.markdown ?? answer.text ?? "";
  const plainText = answer.text ?? answer.markdown ?? "";

  const showCollectedNotice =
    Boolean(askedText && currentQuestionText && askedText !== currentQuestionText);

  // Status notes per §6.6
  const renderStatusNote = () => {
    if (execution.status === "no_answer") {
      const isAio = execution.engine === "aio" || execution.engine === "google_ai_overview";
      return (
        <p className="border-b border-border bg-warning/10 px-5 py-3 text-sm text-warning-foreground dark:text-warning">
          {isAio
            ? "Google showed no AI Overview for this search. This collection is excluded from visibility rates."
            : "No substantive answer was returned. This collection is excluded from visibility rates."}
        </p>
      );
    }
    if (
      execution.status === "failed" ||
      execution.status === "blocked" ||
      execution.status === "unknown"
    ) {
      const errorMsg = answer.error || (execution.status === "blocked" ? "Collection was not attempted (blocked before a request)." : "Collection failed. This answer was not measured.");
      return (
        <p
          role="alert"
          className="border-b border-border bg-destructive/10 px-5 py-3 text-sm text-destructive"
        >
          {errorMsg} This collection is excluded from visibility rates.
        </p>
      );
    }
    return null;
  };

  // Provenance line per §6.6
  const renderProvenance = () => {
    if (execution.quality === "legacy_unknown") {
      return (
        <p className="px-5 py-2 text-xs text-muted-foreground border-b border-border">
          Collected before measurement records; quality unknown.
        </p>
      );
    }
    const prov = answer.provenance;
    if (!prov) return null;
    const model = prov.returnedModel ?? prov.requestedModel ?? "model not reported";
    const loc = prov.requestedLocation ? ` · requested location ${prov.requestedLocation}` : "";
    const gateway = prov.gateway ? ` · via ${prov.gateway}` : "";
    return (
      <p className="px-5 py-2 text-xs text-muted-foreground border-b border-border">
        {prov.methodLabel || prov.method}{gateway} · {model}{loc}
      </p>
    );
  };

  return (
    <div>
      {showCollectedNotice && (
        <p
          className="border-b border-border px-5 py-2 text-xs text-muted-foreground"
          data-ph-mask
        >
          Collected question: {askedText}
        </p>
      )}

      {renderProvenance()}
      {renderStatusNote()}

      {answer.truncated && (
        <p className="border-b border-border bg-warning/5 px-5 py-2 text-xs text-warning-foreground dark:text-warning">
          This response was truncated. The retained evidence may be incomplete.
        </p>
      )}

      {/* Mobile panel toggle (< 1024px) */}
      <div
        className="flex gap-2 border-b border-border px-5 py-3 lg:hidden"
        role="group"
        aria-label="Answer view"
      >
        <Button
          size="sm"
          variant={mobileTab === "answer" ? "secondary" : "outline"}
          aria-pressed={mobileTab === "answer"}
          onClick={() => setMobileTab("answer")}
        >
          Answer
        </Button>
        <Button
          size="sm"
          variant={mobileTab === "citations" ? "secondary" : "outline"}
          aria-pressed={mobileTab === "citations"}
          onClick={() => {
            setMobileTab("citations");
            setEvidenceTab("citations");
          }}
        >
          Citations ({citations.length})
        </Button>
        <Button
          size="sm"
          variant={mobileTab === "brands" ? "secondary" : "outline"}
          aria-pressed={mobileTab === "brands"}
          onClick={() => {
            setMobileTab("brands");
            setEvidenceTab("brands");
          }}
        >
          Brands
        </Button>
      </div>

      {/* Main Grid: article + aside */}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Left: Article */}
        <article
          className={`min-w-0 space-y-4 p-5 text-sm sm:p-6 lg:block ${
            mobileTab !== "answer" ? "hidden" : ""
          }`}
          aria-label="AI answer"
          data-ph-mask
        >
          {displayText ? (
            <MarkdownAnswer text={displayText} collapse={false} />
          ) : (
            <p className="text-muted-foreground">
              No answer was captured. Status: {execution.status}. This is not a negative brand result.
            </p>
          )}
        </article>

        {/* Right: Evidence Aside */}
        <aside
          className={`min-w-0 bg-muted/20 p-4 lg:block lg:border-l border-border ${
            mobileTab === "answer" ? "hidden" : ""
          }`}
          aria-label="Answer evidence"
        >
          <Tabs
            value={evidenceTab}
            onValueChange={(val) => {
              if (val === "citations" || val === "brands") {
                setEvidenceTab(val);
                setMobileTab(val);
              }
            }}
            className="w-full gap-4"
          >
            <TabsList className="hidden w-full lg:flex">
              <TabsTrigger value="citations" className="flex-1">
                Citations ({citations.length})
              </TabsTrigger>
              <TabsTrigger value="brands" className="flex-1">
                Brands
              </TabsTrigger>
            </TabsList>

            {/* Citations Tab */}
            <TabsContent value="citations" className="space-y-3 pt-2">
              {!citations.length ? (
                <p className="text-sm text-muted-foreground">
                  This answer has no citations.
                </p>
              ) : (
                citations.map((source, idx) => (
                  <div
                    key={`${source.url}-${idx}`}
                    className="space-y-2 rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Globe className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{source.domain}</span>
                    </div>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-start gap-1 break-words text-sm font-medium hover:text-primary hover:underline"
                    >
                      <span>{source.title || source.url}</span>
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                    {(source.owned || source.competitor) && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {source.owned && <Badge variant="secondary" size="sm">Your site</Badge>}
                        {source.competitor && (
                          <Badge variant="secondary" size="sm">
                            Competitor: {source.competitor}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </TabsContent>

            {/* Brands Tab */}
            <TabsContent value="brands" className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">
                Mentions appear in the answer text. Citations link to the brand’s domain.
              </p>
              {!brands.length ? (
                <p className="text-sm text-muted-foreground">
                  No brand evidence was captured.
                </p>
              ) : (
                brands.map((brand) => (
                  <div
                    key={brand.name}
                    className="space-y-2 rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{brand.name}</span>
                      {brand.isSelf && (
                        <Badge variant="secondary" size="sm">
                          You
                        </Badge>
                      )}
                    </div>
                    {isAnswered && (
                      <div className="flex flex-wrap gap-1.5">
                        <MentionBadge value={brand.mentioned} size="sm" />
                        {brand.isSelf ? (
                          <MentionBadge
                            value={brand.cited}
                            positive="Cited"
                            negative="Not cited"
                            size="sm"
                          />
                        ) : brand.cited !== null && brand.cited !== undefined ? (
                          <MentionBadge
                            value={brand.cited}
                            positive="Cited"
                            negative="Not cited"
                            size="sm"
                          />
                        ) : null}
                        {brand.position != null && (
                          <Badge variant="outline" size="sm">
                            Position #{brand.position}
                          </Badge>
                        )}
                        {brand.relationship && (
                          <Badge variant="outline" size="sm">
                            {brand.relationship}
                          </Badge>
                        )}
                        {brand.sentimentLabel && (
                          <Badge variant="outline" size="sm">
                            {brand.sentimentLabel.charAt(0).toUpperCase() +
                              brand.sentimentLabel.slice(1)}
                          </Badge>
                        )}
                      </div>
                    )}
                    {brand.spans && brand.spans.length > 0 && plainText && (
                      <Accordion className="w-full">
                        <AccordionItem value="mentions">
                          <AccordionTrigger className="py-1 text-xs">
                            Mention excerpts ({brand.spans.length})
                          </AccordionTrigger>
                          <AccordionContent
                            className="space-y-2 pt-2 text-xs text-muted-foreground"
                            data-ph-mask
                          >
                            {brand.spans.map((span, sIdx) => {
                              const parts = excerpt(plainText, span, 70);
                              return (
                                <p key={`${span.start}-${span.end}-${sIdx}`}>
                                  “{parts.before}
                                  <mark className="bg-primary/15 text-foreground">
                                    {parts.match}
                                  </mark>
                                  {parts.after}”
                                </p>
                              );
                            })}
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </div>
                ))
              )}
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      {/* Evidence Footer */}
      <EvidenceFooter evidence={answer.evidence} />
    </div>
  );
}

function EvidenceFooter({ evidence }: { evidence: AnswerDetail["evidence"] }) {
  if (!evidence || evidence.state === "none" || evidence.state === "legacy_unknown") {
    return null;
  }

  const handleEvidenceClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    e.preventDefault();
    try {
      const res = await fetch(href, { redirect: "manual" });
      if (res.status === 410) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        toast.error(
          body.message ||
            body.error ||
            "Raw capture expired under the retention policy. The measurement is retained.",
        );
        return;
      }
      window.open(href, "_blank", "noopener,noreferrer");
    } catch {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground flex flex-wrap items-center gap-2">
      {evidence.state === "stored" && (
        <>
          {evidence.captures.map((cap) => (
            <span key={cap.index} className="flex items-center gap-1.5">
              {cap.href ? (
                <a
                  href={cap.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => handleEvidenceClick(e, cap.href!)}
                  className="font-medium text-primary hover:underline"
                >
                  Raw capture: Open
                </a>
              ) : (
                <span>Raw capture: Stored</span>
              )}
              {cap.expiresAt && (
                <span>
                  {" "}· expires {new Date(cap.expiresAt).toLocaleDateString()}
                </span>
              )}
            </span>
          ))}
        </>
      )}
      {evidence.state === "expired" && (
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" size="sm">
            Expired
          </Badge>
          <span>
            Raw capture expired under the retention policy. The measurement is retained.
          </span>
        </span>
      )}
      {evidence.state === "withdrawn" && (
        <span className="flex items-center gap-1.5">
          <Badge variant="destructive" size="sm">
            Withdrawn
          </Badge>
          <span>
            This capture was withdrawn because its redaction could not be verified. The measurement is retained.
          </span>
        </span>
      )}
      {evidence.state === "incomplete" && (
        <span>Raw capture was not stored for this answer.</span>
      )}
    </div>
  );
}
