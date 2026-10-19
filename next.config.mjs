import { PRIVATE_ROUTE_PREFIXES, getRouteIndexingPolicy } from "./src/lib/publicSite.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        const preview = !getRouteIndexingPolicy("/", process.env).index;
        return (preview ? ["/:path*"] : PRIVATE_ROUTE_PREFIXES.map((prefix) => `${prefix}/:path*`)).map((source) => ({
            source,
            headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
        }));
    },
    async redirects() {
        return [{ source: "/:path*", has: [{ type: "host", value: "www.perceev.com" }],
            destination: "https://perceev.com/:path*", permanent: true }];
    },
    // Content-pipeline skill prompts are markdown files read from disk at
    // runtime (loader.js). Serverless bundling only traces imported modules,
    // so the .md files must be included explicitly or content routes break
    // in production.
    outputFileTracingIncludes: {
      "/api/customer/content/**": ["./src/lib/content/skills/*.md"],
      "/api/content": ["./src/lib/content/skills/*.md"],
      "/api/content/**": ["./src/lib/content/skills/*.md"],
      "/api/content-items/**": ["./src/lib/content/skills/*.md"],
      "/api/scan/worker": ["./src/lib/content/skills/*.md"],
    },
};

export default nextConfig;
