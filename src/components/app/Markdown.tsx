"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/Markdown.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/utils";
import { safeHttpUrl } from "@/shared/safe-url";

type Props = {
  /** Raw Markdown source to render. */
  children: string;
  className?: string;
};

// react-markdown also passes the hast `node`; it must not reach the DOM.
type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

function SafeAnchor({ href, children, node: _node, ...rest }: AnchorProps) {
  const safeHref = safeHttpUrl(href);
  if (!safeHref) {
    return <span className="underline decoration-dotted">{children}</span>;
  }
  return (
    <a
      {...rest}
      href={safeHref}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  );
}

export const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mt-5 mb-2 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-5 mb-2 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  a: SafeAnchor,
  // Markdown here can be model output, which is untrusted. Loading a remote
  // image would let it beacon out of the signed-in app, so show the alt text.
  img: ({ alt }: ComponentPropsWithoutRef<"img">) =>
    alt ? <span className="italic text-muted-foreground">[{alt}]</span> : null,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em className="italic">{children}</em>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-foreground/80 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  // Every `code` gets the inline badge style; `pre` strips it from the code
  // inside a fenced block, with or without a language.
  code: ({ children, className }: ComponentPropsWithoutRef<"code">) => (
    <code
      className={cn("rounded bg-muted px-1 py-0.5 text-xs font-mono", className)}
    >
      {children}
    </code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-muted p-3 text-xs font-mono [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border border-border text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => (
    <tr className="border-b border-border last:border-0">{children}</tr>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-2 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-2 py-1.5 align-top">{children}</td>
  ),
};

/**
 * Shared Markdown renderer with explicit per-element Tailwind classes.
 * Anchor URLs are sanitized to http(s) only; images are never loaded.
 */
export function Markdown({ children, className }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
