// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/Markdown.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { MARKDOWN_COMPONENTS } from "@/components/app/Markdown";

/**
 * The assistant's Markdown renderer. Model output is untrusted: a remote
 * image would beacon out of the signed-in app, so images render as a plain
 * "[image: alt]" label and are never loaded.
 */
export const ASSISTANT_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_COMPONENTS,
  img: ({ alt }: { alt?: string }) =>
    alt ? <span className="text-muted-foreground">[image: {alt}]</span> : null,
};
