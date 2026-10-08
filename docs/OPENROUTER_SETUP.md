# OpenRouter UAT configuration

> <!-- doc-status -->
> **Status: LIVE.** User-selected local model configuration. Hosted deployment has not been updated by this change.

## Selected models

| Role/selection | Local variable | Exact OpenRouter ID |
|---|---|---|
| Gemini; assigned to prompt generation and competitor extraction | LLM_MODEL and OPENROUTER_GEMINI_MODEL | google/gemini-3.8-flash |
| Perplexity selection | OPENROUTER_PERPLEXITY_MODEL | perplexity/sonar |
| OpenAI selection | OPENROUTER_OPENAI_MODEL | openai/gpt-6-luna |
| Content Studio | CONTENT_MODEL | openai/gpt-6-luna |

LLM_BASE_URL is https://openrouter.ai/api/v1. LLM_API_KEY holds the user-provided OpenRouter key in the ignored .env.local file; its value is never included here. The same key powers internal generation and content. Existing credentials were preserved.

All three exact IDs were found in the live OpenRouter model catalog. Authenticated calls through the app client confirmed Gemini and GPT produce parseable JSON, with real cost returned by the gateway. Sonar rejects the generic JSON-object response format. The app client now selects Sonar’s supported text mode with an explicit JSON instruction; the existing llmJson parser and retry contract validate objects and arrays. Live calls through llmJson passed for both shapes, with gateway-reported cost. This is parsed JSON, not provider-enforced JSON Schema. Sonar is not assigned to internal generation or content in this configuration.

The provider-named OPENROUTER_*_MODEL fields record selections; current runtime code does not consume them. LLM_MODEL and CONTENT_MODEL do select the working internal paths. Native ChatGPT/Perplexity scan adapters remain separate and are not rerouted to OpenRouter by this change. Local configuration alone does not change the hosted product.

Restart the local app after environment changes. Before deployment, exercise real 30-question prompt generation, verify Content Studio generation and recorded cost, then set the same working configuration in the chosen Vercel environment and redeploy. A minimal JSON call proves connectivity/format compatibility, not a whole saved scan or draft.

Prompt-generation acceptance: the actual generateUnbrandedPrompts path, using live Gemini with controlled illustrative tile-site input and empty injected search seeds, produced 30/30 prompts, all LLM-generated and all passing the elicitation check. Gateway-reported total cost was $0.01449225. This test wrote no customer scan rows and does not establish live scraping/SERP behavior or a deployed saved scan.

Sonar fix scope: only OpenRouter perplexity/sonar-family models in jsonMode use the compatible text format. Gemini/GPT retain json_object. Malformed Sonar output still retries and ultimately returns null; plain-text calls stay unchanged. Regression tests cover both shapes, malformed-output retry, cost recording and other selected models. No deployment or native scan-engine rerouting was performed.

Post-fix verification: live Sonar through the actual prompt generator with controlled illustrative site/seed inputs produced 30/30 prompts, all LLM-generated and eliciting, with $0.0068 gateway-reported cost. Live llmJson object and array checks also passed. The targeted OpenRouter tests passed 47/47 and the production build passed. These checks did not write customer scan rows or change the hosted environment.
