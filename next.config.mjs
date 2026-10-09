/** @type {import('next').NextConfig} */
const nextConfig = {
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
