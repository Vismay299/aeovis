# Third-party notices

This project contains portions ported from the open-source projects below.

## every-app/open-seo (MIT)

Pinned reference: `c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4`.

MIT License

Copyright (c) 2026 Ben Senescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Files containing ported portions

- `src/lib/http/schemaContract.ts`
- `src/lib/http/routeContract.test.ts`
- `src/lib/http/hostPolicy.ts`
- `src/lib/jobs/stepConfigs.ts`
- `src/lib/jobs/watchdog.ts`
- `src/lib/spend/index.ts`
- `src/lib/cache/providerCache.ts`
- `src/lib/llm/openrouter.ts`
- `src/lib/telemetry/server.ts` (and `server.test.ts` message-stripping cases)
- `src/shared/privacy-choices.ts` (and `privacy-choices.test.ts`)
- `src/lib/telemetry/sanitize.ts` (and `sanitize.test.ts`)
- `src/lib/telemetry/client.ts` (and `client.test.ts` buffer/opt-in cases)
- `supabase/migrations/041_f01_spend.sql`
