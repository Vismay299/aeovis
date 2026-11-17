// llms.txt validation for Perceev site audit.
// Checks existence, content type, and initial H1 title line.

import { safeFetch as defaultSafeFetch } from "../../shared/http/safeFetch.ts";

export type LlmsTxtStatus = "present" | "missing" | "invalid" | "unreachable";

export interface LlmsTxtResult {
  status: LlmsTxtStatus;
  httpStatus: number | null;
  contentType: string | null;
  firstLine: string | null;
}

export async function checkLlmsTxt(
  origin: string,
  deps?: {
    safeFetch?: typeof defaultSafeFetch;
    lookup?: (host: string) => Promise<string[]>;
  },
): Promise<LlmsTxtResult> {
  const fetcher = deps?.safeFetch ?? defaultSafeFetch;
  const llmsUrl = `${origin.replace(/\/+$/, "")}/llms.txt`;

  try {
    const res = await fetcher(
      llmsUrl,
      {
        method: "GET",
        maxRedirects: 3,
        maxBytes: 65_536,
        truncate: true,
        timeoutMs: 8_000,
      },
      deps?.lookup ? { lookup: deps.lookup } : undefined,
    );

    const contentType = res.headers.get("content-type");

    if (res.status === 404 || res.status === 410) {
      return {
        status: "missing",
        httpStatus: res.status,
        contentType,
        firstLine: null,
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        status: "unreachable",
        httpStatus: res.status,
        contentType,
        firstLine: null,
      };
    }

    const text = res.text();
    const firstLine =
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? null;

    const isHtml =
      typeof contentType === "string" &&
      contentType.toLowerCase().includes("text/html");

    const startsWithH1 = firstLine !== null && firstLine.startsWith("# ");

    if (isHtml || !startsWithH1) {
      return {
        status: "invalid",
        httpStatus: res.status,
        contentType,
        firstLine,
      };
    }

    return {
      status: "present",
      httpStatus: res.status,
      contentType,
      firstLine,
    };
  } catch {
    return {
      status: "unreachable",
      httpStatus: null,
      contentType: null,
      firstLine: null,
    };
  }
}
