import { NOINDEX_ROUTE_PREFIXES, PRIVATE_ROUTE_PREFIXES, getRouteIndexingPolicy } from "./src/server/publicSite.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        const preview = !getRouteIndexingPolicy("/", process.env).index;
        // Private prefixes are disallowed in robots.txt; the noindex-only
        // prefixes (F23 /s) are not, but both map to the same header so every
        // document response carries X-Robots-Tag even on its 404 bodies.
        const noindexPrefixes = [...PRIVATE_ROUTE_PREFIXES, ...NOINDEX_ROUTE_PREFIXES];
        const rules = (preview ? ["/:path*"] : noindexPrefixes.map((prefix) => `${prefix}/:path*`)).map((source) => ({
            source,
            headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
        }));
        rules.push({
            source: "/ingest/:path*",
            headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
        });
        return rules;
    },
    async rewrites() {
        const ingest = process.env.POSTHOG_INGEST_ORIGIN || "https://eu.i.posthog.com";
        const assets = process.env.POSTHOG_ASSETS_ORIGIN || "https://eu-assets.i.posthog.com";
        return [
            { source: "/ingest/static/:path*", destination: `${assets}/static/:path*` },
            { source: "/ingest/:path*", destination: `${ingest}/:path*` },
        ];
    },
    skipTrailingSlashRedirect: true,
    productionBrowserSourceMaps: process.env.POSTHOG_SOURCEMAPS === "true",
    async redirects() {
        return [{ source: "/:path*", has: [{ type: "host", value: "www.perceev.com" }],
            destination: "https://perceev.com/:path*", permanent: true }];
    },
    // Content-pipeline skill prompts are markdown files read from disk at
    // runtime (loader.js). Serverless bundling only traces imported modules,
    // so the .md files must be included explicitly or content routes break
    // in production.
    outputFileTracingIncludes: {
      "/api/customer/content/**": ["./src/shared/content/skills/*.md"],
      "/api/content": ["./src/shared/content/skills/*.md"],
      "/api/content/**": ["./src/shared/content/skills/*.md"],
      "/api/content-items/**": ["./src/shared/content/skills/*.md"],
      "/api/scan/worker": ["./src/shared/content/skills/*.md"],
    },
};

export default nextConfig;
