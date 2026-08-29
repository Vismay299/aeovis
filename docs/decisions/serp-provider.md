# Decision Note: SERP API Provider for Google AI Overview (SGE)

> <!-- doc-status -->
> **Status: SUPERSEDED-BY** [2026-08-29-serp-provider-bright-data.md](./2026-08-29-serp-provider-bright-data.md).
> This note chose SerpAPI. Production ships **Bright Data**, and has for some
> time; the second decision was never written down, so this document was the
> only ADR in the repository and it described a provider the code does not use.
> Kept because its comparison of what AI Overview probing requires is still the
> best write-up of the problem — but every number below is a SerpAPI number and
> describes nothing we run.

## Context
Google's AI Overview (formerly Search Generative Experience, or SGE) has become the primary answer engine result shown to users for informational and commercial queries. Probing live AI Overviews requires querying Google search results dynamically and parsing the generated AI Overview box. 

We compared the two leading search data providers: **SerpAPI** and **DataForSEO**.

---

## Comparison Matrix

| Criteria | SerpAPI | DataForSEO |
| :--- | :--- | :--- |
| **AI Overview (SGE) support** | First-class native support (via `ai_overview` payload blocks). | Supported as parsed HTML features, but less granular citation link maps. |
| **Deferred Loading** | Returns a `page_token` for async generated overviews, enabling a second call to resolve the content. | Requires customized webhook setups or high latency polling for deferred overviews. |
| **Pricing** | ~$0.01 per query on standard developer tier. | ~$0.002 to $0.005 per query (slightly cheaper but higher integration complexity). |
| **Geo & Device Parameters** | Full support for device types (desktop/mobile) and precise location codes (`gl`, `hl`, `uule`). | Full support, but location mapping is done via their proprietary location database. |
| **Developer Experience** | Zero-dependency HTTP requests, detailed documentation, and instant JSON response parsing. | SOAP/REST API format requiring complex task post-and-get architectures. |

---

## Conclusion & Chosen Provider

We have chosen **SerpAPI** as the primary search provider for the following reasons:
1. **Async Page Token Support**: SerpAPI's ability to return a `page_token` for asynchronously loaded overviews allows us to reliably query the `google_ai_overview` engine to resolve deferred overviews, ensuring a high coverage rate in production.
2. **Simplified Integration**: The SerpAPI Google engine returns structured citation mapping (`references` link arrays) that are easy to parse and classify.
3. **Graceful Degradation**: Cost-per-scan for the standard 15-prompt set is roughly **$0.15** (15 queries × $0.01). If the `SERPAPI_KEY` is absent, the system degrades gracefully into LLM-only mode.

## Cost-Per-Scan Estimates (15 Prompts)

- **LLM-Only Mode**: Free (Dev / Fallback using local Gemini / OpenAI / Perplexity API keys).
- **Hybrid Production Mode**: **$0.15** SerpAPI query cost + LLM query costs.
