// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/reportSocialImage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { ImageResponse } from "next/og";

/**
 * The link preview image: one template for all reports, rendered locally with
 * the default bundled font — titles never go to an image service and no
 * remote asset is fetched. The handler in documentRoutes.ts re-checks the
 * token on every request, so a revoked title never lives in a cache.
 */
export async function renderReportSocialImage(title: string, host: string | null): Promise<Response> {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          padding: 64,
          backgroundColor: "#ffffff",
          color: "#0a0a0a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              background: "linear-gradient(135deg, #3730CE, #5B54F0)",
            }}
          />
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1 }}>perceev</div>
        </div>
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            paddingTop: 24,
          }}
        >
          <div
            style={{
              fontSize: title.length > 85 ? 54 : title.length > 48 ? 64 : 80,
              fontWeight: 700,
              letterSpacing: -2,
              lineHeight: 1.12,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </div>
        </div>
        {host ? (
          <div
            style={{
              position: "absolute",
              right: 64,
              bottom: 28,
              maxWidth: "80%",
              fontSize: 24,
              fontWeight: 400,
              color: "#65716b",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {host}
          </div>
        ) : null}
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}
