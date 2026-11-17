import { PREFERRED_PRODUCTION_ORIGIN, PRIVATE_ROUTE_PREFIXES } from "../server/publicSite.js";

export default function robots() {
  const isPreview =
    process.env.VERCEL_ENV === "preview" ||
    process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" ||
    Boolean(process.env.PERCEEV_IS_PREVIEW);

  if (isPreview) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: PRIVATE_ROUTE_PREFIXES.flatMap((prefix) => [prefix + "$", `${prefix}/`]),
    },
    sitemap: `${PREFERRED_PRODUCTION_ORIGIN}/sitemap.xml`,
  };
}
