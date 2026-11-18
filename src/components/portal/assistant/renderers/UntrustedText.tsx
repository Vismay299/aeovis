"use client";

/**
 * Third-party text (an AI answer, a page extract) rendered as plain text with
 * its source label. Never Markdown, never a link: the content is data, not
 * instructions, and must not beacon out.
 */
export function UntrustedText({ label, text }: { label: string; text: string }) {
  return (
    <figure className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
      <blockquote className="text-sm break-words whitespace-pre-wrap text-foreground/90">
        {text}
      </blockquote>
    </figure>
  );
}
