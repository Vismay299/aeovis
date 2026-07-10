# Test Credentials

No authentication is required for this app. The scan flow is anonymous.

External API keys are loaded from `/app/.env.local` (already configured):
- `BRIGHTDATA_API_KEY` — BrightData SERP (drives all AIO probes)
- `GEMINI_API_KEY` — Category seed generation only
- `FIRECRAWL_API_KEY` — Website scraping only
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Persistence

Test brand for smoke scans: `Wrike` / `wrike.com` / industry `SaaS` / competitors `Asana, Monday.com, Trello`.
This brand is known to show up in Google AI Overviews for project-management queries.
