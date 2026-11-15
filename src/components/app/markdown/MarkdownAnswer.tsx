"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/components/MarkdownAnswer.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "@/components/app/Markdown";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type Props = {
  text: string;
  collapse?: boolean;
};

const COLLAPSED_MAX_PX = 240;

const ANSWER_COMPONENTS = {
  ...MARKDOWN_COMPONENTS,
  img: ({ alt }: ComponentPropsWithoutRef<"img">) => (
    <span className="italic text-muted-foreground">
      {alt ? `[Image: ${alt}]` : "[Image]"}
    </span>
  ),
};

export function MarkdownAnswer({ text, collapse = false }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const { thinking, body } = extractThinkingBlocks(text || "");
  const normalized = normalizeLlmMarkdown(body);

  useLayoutEffect(() => {
    if (!collapse) {
      setNeedsCollapse(false);
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    setNeedsCollapse(el.scrollHeight > COLLAPSED_MAX_PX + 8);
  }, [normalized, collapse]);

  if (normalized.trim().length === 0 && thinking.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Model returned an empty response.
      </p>
    );
  }

  const isCollapsed = collapse && needsCollapse && !expanded;

  return (
    <div className="text-sm leading-relaxed">
      {thinking.map((block, index) => (
        <ThinkingBlock key={index} text={block} />
      ))}

      {normalized.trim().length > 0 ? (
        <div className="relative">
          <div
            ref={contentRef}
            style={
              isCollapsed ? { maxHeight: `${COLLAPSED_MAX_PX}px` } : undefined
            }
            className={isCollapsed ? "overflow-hidden" : undefined}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={ANSWER_COMPONENTS}
            >
              {normalized}
            </ReactMarkdown>
          </div>

          {isCollapsed ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent"
            />
          ) : null}
        </div>
      ) : null}

      {collapse && needsCollapse ? (
        <Button
          variant="link"
          size="xs"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-2 h-auto px-0"
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <ChevronUp data-icon="inline-start" className="size-3.5" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown data-icon="inline-start" className="size-3.5" />
              Read more
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible
      defaultOpen
      className="mb-3 rounded-lg border border-border bg-muted/40"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronDown className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
        Model Thinking
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="overflow-x-auto rounded-b-lg border-t border-border bg-muted/60 px-3 py-2.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground/80">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function extractThinkingBlocks(text: string): {
  thinking: string[];
  body: string;
} {
  const thinking: string[] = [];
  let body = text;

  body = body.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner: string) => {
    thinking.push(inner.trim());
    return "";
  });

  body = body.replace(/<think>([\s\S]*)$/i, (_, inner: string) => {
    thinking.push(inner.trim());
    return "";
  });

  return { thinking, body };
}

function normalizeLlmMarkdown(text: string): string {
  return text.replace(
    /^([ \t]*)([-*+]|\d+\.)[ \t]*\r?\n[ \t]*\r?\n(?=\S)(?![ \t]*(?:[-*+]|\d+\.)[ \t])/gm,
    "$1$2 ",
  );
}
