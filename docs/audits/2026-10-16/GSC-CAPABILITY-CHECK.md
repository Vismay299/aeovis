# Search Console capability check

> <!-- doc-status -->
> **Status: LIVE.** Source distinctions checked 20 October 2026, Asia/Kolkata.

Google announced dedicated Generative AI performance reports for Search and Discover on 3 June 2026. Its announcement now states worldwide availability as of 31 August 2026. The report describes impressions with page, country, device and date dimensions. [Google announcement](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports).

The current Perceev integration calls the Search Analytics API for web query rows. The [documented API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) lists web, image, video, news, Google News and Discover types. That documentation does not establish a Generative AI report API for this integration. This is a limit of our implemented import and verified API contract; it is not a claim that Search Console has no AI reporting.

The API now labels this source and marks AI visibility as not imported. Query totals omit anonymized queries and must not be presented as property totals or AI-only exposure. Importing the separate report and verifying it on the authorized property remain unverified.
