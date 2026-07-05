const apiKey = process.env.FIRECRAWL_API_KEY;

/**
 * Scrape a website using Firecrawl API (when key is present) and return
 * clean content suitable for LLM prompt generation.
 *
 * Falls back to basic fetch + HTML stripping when no key or on error.
 */
export async function scrapeForSummary(url) {
  if (!url) {
    return "No website content available.";
  }

  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;

  // Primary path: Firecrawl (clean markdown + metadata)
  if (apiKey) {
    try {
      const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: normalizedUrl,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (response.ok) {
        const data = await response.json();
        const result = data.data || data; // Firecrawl sometimes wraps differently

        let content = "";

        if (result.metadata?.title) {
          content += `Title: ${result.metadata.title}\n`;
        }
        if (result.metadata?.description) {
          content += `Description: ${result.metadata.description}\n\n`;
        }
        if (result.markdown) {
          content += result.markdown;
        }

        if (content.trim().length > 50) {
          return content.slice(0, 7000);
        }
      } else {
        console.warn(`[Firecrawl] API error ${response.status} for ${normalizedUrl}`);
      }
    } catch (error) {
      console.warn(`[Firecrawl] Request failed for ${normalizedUrl}:`, error.message || error);
      // fall through to basic
    }
  }

  // Fallback: basic fetch + crude HTML strip
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(normalizedUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const text = await res.text();
      const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyText = bodyMatch ? bodyMatch[1] : text;
      const cleaned = bodyText
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return cleaned.slice(0, 4000) || "No website content available.";
    }
  } catch (error) {
    console.warn(`[Basic fetch] Failed for ${normalizedUrl}:`, error);
  }

  return "No website content available.";
}
