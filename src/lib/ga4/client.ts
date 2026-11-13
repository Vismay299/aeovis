// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/ga4Client.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import {
  Ga4AdminApiError,
  Ga4DataApiError,
  Ga4MalformedResponseError,
  Ga4TokenError,
} from "./errors.ts";

export {
  Ga4AdminApiError,
  Ga4DataApiError,
  Ga4MalformedResponseError,
  Ga4TokenError,
};

const GA4_ADMIN_API_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_ADMIN_ALPHA_API_BASE = "https://analyticsadmin.googleapis.com/v1alpha";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GA4_DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const MAX_ACCOUNT_SUMMARY_PAGES = 100;
const MAX_ERROR_BODY_LENGTH = 8_000;
const RETRY_DELAY_MS = 500;
const DATA_CONCURRENCY = 4;

const propertyIdSchema = z.string().regex(/^properties\/\d+$/);
const dataStreamNameSchema = z.string().regex(/^properties\/\d+\/dataStreams\/\d+$/);

const propertySummarySchema = z.object({
  property: propertyIdSchema,
  displayName: z.string(),
});

const accountSummarySchema = z.object({
  account: z.string().regex(/^accounts\/\d+$/),
  displayName: z.string(),
  propertySummaries: z.array(propertySummarySchema).optional(),
});

const accountSummariesResponseSchema = z.object({
  accountSummaries: z.array(accountSummarySchema).optional(),
  nextPageToken: z.string().optional(),
});

const propertySchema = z.object({
  name: propertyIdSchema,
  displayName: z.string(),
  timeZone: z.string().min(1),
  currencyCode: z.string().min(1),
});

const dataStreamSchema = z.object({
  name: dataStreamNameSchema,
  type: z.string(),
  displayName: z.string().default(""),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  webStreamData: z
    .object({
      measurementId: z.string().optional(),
      defaultUri: z.string().optional(),
    })
    .optional(),
  androidAppStreamData: z.object({ packageName: z.string().optional() }).optional(),
  iosAppStreamData: z.object({ bundleId: z.string().optional() }).optional(),
});
const dataStreamsResponseSchema = z.object({
  dataStreams: z.array(dataStreamSchema).optional(),
  nextPageToken: z.string().optional(),
});

const enhancedMeasurementSettingsSchema = z.object({
  streamEnabled: z.boolean().default(false),
  scrollsEnabled: z.boolean().default(false),
  outboundClicksEnabled: z.boolean().default(false),
  siteSearchEnabled: z.boolean().default(false),
  videoEngagementEnabled: z.boolean().default(false),
  fileDownloadsEnabled: z.boolean().default(false),
  pageChangesEnabled: z.boolean().default(false),
  formInteractionsEnabled: z.boolean().default(false),
  searchQueryParameter: z.string().default(""),
  uriQueryParameter: z.string().optional().default(""),
});

const keyEventSchema = z.object({
  eventName: z.string(),
  createTime: z.string().optional(),
  deletable: z.boolean().optional(),
  custom: z.boolean().optional(),
  countingMethod: z.string(),
  defaultValue: z
    .object({ numericValue: z.number(), currencyCode: z.string() })
    .optional(),
});
const keyEventsResponseSchema = z.object({
  keyEvents: z.array(keyEventSchema).optional(),
  nextPageToken: z.string().optional(),
});

const customDimensionSchema = z.object({
  parameterName: z.string(),
  displayName: z.string(),
  description: z.string().optional().default(""),
  scope: z.string(),
  disallowAdsPersonalization: z.boolean().optional().default(false),
});
const customDimensionsResponseSchema = z.object({
  customDimensions: z.array(customDimensionSchema).optional(),
  nextPageToken: z.string().optional(),
});

const customMetricSchema = z.object({
  parameterName: z.string(),
  displayName: z.string(),
  description: z.string().optional().default(""),
  measurementUnit: z.string(),
  scope: z.string(),
  restrictedMetricType: z.array(z.string()).optional().default([]),
});
const customMetricsResponseSchema = z.object({
  customMetrics: z.array(customMetricSchema).optional(),
  nextPageToken: z.string().optional(),
});

export type Ga4PropertySummary = {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
};

export type Ga4Property = z.infer<typeof propertySchema>;

const quotaStatusSchema = z.object({
  consumed: z.number().int(),
  remaining: z.number().int(),
});

const propertyQuotaSchema = z.object({
  tokensPerDay: quotaStatusSchema.optional(),
  tokensPerHour: quotaStatusSchema.optional(),
  concurrentRequests: quotaStatusSchema.optional(),
  serverErrorsPerProjectPerHour: quotaStatusSchema.optional(),
  potentiallyThresholdedRequestsPerHour: quotaStatusSchema.optional(),
  tokensPerProjectPerHour: quotaStatusSchema.optional(),
});

const responseMetadataSchema = z.object({
  dataLossFromOtherRow: z.boolean().optional(),
  samplingMetadatas: z
    .array(z.object({ samplesReadCount: z.string(), samplingSpaceSize: z.string() }))
    .optional(),
  schemaRestrictionResponse: z
    .object({
      activeMetricRestrictions: z
        .array(z.object({ metricName: z.string(), restrictedMetricTypes: z.array(z.string()).optional() }))
        .optional(),
    })
    .optional(),
  currencyCode: z.string().optional(),
  timeZone: z.string().optional(),
  emptyReason: z.string().optional(),
  subjectToThresholding: z.boolean().optional(),
});

const runReportResponseSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string() })).optional(),
  metricHeaders: z.array(z.object({ name: z.string(), type: z.string().optional() })).optional(),
  rows: z
    .array(
      z.object({
        dimensionValues: z.array(z.object({ value: z.string() })).optional(),
        metricValues: z.array(z.object({ value: z.string() })).optional(),
      }),
    )
    .optional(),
  rowCount: z.number().int().nonnegative().optional(),
  metadata: responseMetadataSchema.optional(),
  propertyQuota: propertyQuotaSchema.optional(),
  kind: z.string().optional(),
});

export type Ga4RunReportResponse = z.infer<typeof runReportResponseSchema>;

export type Ga4RunReportRequest = {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: unknown;
  metricFilter?: unknown;
  offset: string;
  limit: string;
  orderBys: Array<{
    metric?: { metricName: string };
    dimension?: { dimensionName: string };
    desc?: boolean;
  }>;
  keepEmptyRows: false;
  returnPropertyQuota: true;
};

const googleErrorSchema = z.object({
  error: z.object({
    details: z
      .array(z.object({ reason: z.string().optional(), metadata: z.object({ service: z.string().optional() }).optional() }))
      .optional(),
  }),
});

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function memoizeToken(getToken: () => Promise<string>): () => Promise<string> {
  let promise: Promise<string> | undefined;
  return () => (promise ??= getToken());
}

function adminMessageForStatus(status: number): string {
  if (status === 401) return "Google Analytics connection expired.";
  if (status === 403) return "Google Analytics denied access. Check the account's property access and enabled APIs.";
  if (status === 429) return "Google Analytics rate limit reached.";
  return `Google Analytics Admin API error (${status}).`;
}

function dataMessageForStatus(status: number): string {
  if (status === 400) return "Google Analytics rejected this report.";
  if (status === 401) return "Google Analytics connection expired.";
  if (status === 403) return "Google Analytics denied access to this property.";
  if (status === 429) return "Google Analytics reporting quota was exhausted.";
  return "Google Analytics reporting is temporarily unavailable.";
}

function safeRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), 86_400);
}

// Per-property semaphore for Data API concurrency.
const dataSemaphores = new Map<string, { active: number; queue: Array<() => void> }>();
function getDataSem(key: string) {
  if (!dataSemaphores.has(key)) dataSemaphores.set(key, { active: 0, queue: [] });
  return dataSemaphores.get(key)!;
}
async function acquireDataSem(key: string) {
  const sem = getDataSem(key);
  if (sem.active < DATA_CONCURRENCY) {
    sem.active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    sem.queue.push(resolve);
  });
  sem.active += 1;
}
function releaseDataSem(key: string) {
  const sem = getDataSem(key);
  sem.active = Math.max(0, sem.active - 1);
  const next = sem.queue.shift();
  if (next) next();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Ga4AdminClientDeps {
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function createGa4AdminClient(deps: Ga4AdminClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = memoizeToken(deps.getToken);

  async function request(url: string): Promise<unknown> {
    const token = await getToken().catch((err) => {
      throw new Ga4TokenError("Could not mint a Google Analytics access token.", err);
    });

    const doFetch = async (): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        return await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    // First attempt
    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      if (isAbortError(err)) throw err;
      // network failure: retry once after 500ms
      await sleep(RETRY_DELAY_MS);
      try {
        response = await doFetch();
      } catch (err2) {
        if (isAbortError(err2)) throw err2;
        throw new Ga4AdminApiError(0, "Google Analytics Admin API is temporarily unavailable.");
      }
    }

    // 5xx: retry once after 500ms
    if (response.status >= 500 && response.status < 600) {
      await sleep(RETRY_DELAY_MS);
      let response2: Response;
      try {
        response2 = await doFetch();
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw new Ga4AdminApiError(0, "Google Analytics Admin API is temporarily unavailable.");
      }
      if (!response2.ok) {
        throw new Ga4AdminApiError(response2.status, adminMessageForStatus(response2.status));
      }
      try {
        return await response2.json();
      } catch {
        throw new Ga4MalformedResponseError();
      }
    }

    if (!response.ok) {
      throw new Ga4AdminApiError(response.status, adminMessageForStatus(response.status));
    }

    try {
      return await response.json();
    } catch {
      throw new Ga4MalformedResponseError();
    }
  }

  // The above request() is messy with double retry. Rewrite cleanly:
  // We'll replace request() below by redefining. But function already declared. Instead, let's just keep a cleaner version by overriding.
  // (placeholder removed)

  function propertyUrl(base: string, propertyId: string, child: string): URL {
    const canonicalId = propertyIdSchema.parse(propertyId);
    return new URL(`${base}/${canonicalId}/${child}`);
  }

  return {
    async getUserInfoEmail(): Promise<string | null> {
      const data = z.object({ email: z.string().email().optional() }).parse(await request(GOOGLE_USERINFO_URL));
      return data.email ?? null;
    },
    async listProperties(): Promise<Ga4PropertySummary[]> {
      const properties: Ga4PropertySummary[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_ACCOUNT_SUMMARY_PAGES; page += 1) {
        const url = new URL(`${GA4_ADMIN_API_BASE}/accountSummaries`);
        url.searchParams.set("pageSize", "200");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = accountSummariesResponseSchema.parse(await request(url.toString()));
        for (const account of response.accountSummaries ?? []) {
          for (const property of account.propertySummaries ?? []) {
            properties.push({
              propertyId: property.property,
              displayName: property.displayName,
              accountDisplayName: account.displayName,
            });
          }
        }
        pageToken = response.nextPageToken || undefined;
        if (!pageToken) return properties;
      }
      throw new Error("Google Analytics property discovery exceeded 100 pages.");
    },
    async getProperty(propertyId: string): Promise<Ga4Property> {
      const canonicalId = propertyIdSchema.parse(propertyId);
      return propertySchema.parse(await request(`${GA4_ADMIN_API_BASE}/${canonicalId}`));
    },
    async listDataStreams(propertyId: string) {
      const url = propertyUrl(GA4_ADMIN_ALPHA_API_BASE, propertyId, "dataStreams");
      url.searchParams.set("pageSize", "200");
      const response = dataStreamsResponseSchema.parse(await request(url.toString()));
      return response.dataStreams ?? [];
    },
    async getEnhancedMeasurementSettings(streamName: string) {
      const canonicalName = dataStreamNameSchema.parse(streamName);
      return enhancedMeasurementSettingsSchema.parse(
        await request(`${GA4_ADMIN_ALPHA_API_BASE}/${canonicalName}/enhancedMeasurementSettings`),
      );
    },
    async listKeyEvents(propertyId: string) {
      const url = propertyUrl(GA4_ADMIN_API_BASE, propertyId, "keyEvents");
      url.searchParams.set("pageSize", "200");
      const response = keyEventsResponseSchema.parse(await request(url.toString()));
      return response.keyEvents ?? [];
    },
    async listCustomDimensions(propertyId: string) {
      const url = propertyUrl(GA4_ADMIN_API_BASE, propertyId, "customDimensions");
      url.searchParams.set("pageSize", "200");
      const response = customDimensionsResponseSchema.parse(await request(url.toString()));
      return response.customDimensions ?? [];
    },
    async listCustomMetrics(propertyId: string) {
      const url = propertyUrl(GA4_ADMIN_API_BASE, propertyId, "customMetrics");
      url.searchParams.set("pageSize", "200");
      const response = customMetricsResponseSchema.parse(await request(url.toString()));
      return response.customMetrics ?? [];
    },
  };
}

export interface Ga4DataClientDeps {
  getToken: () => Promise<string>;
  propertyId: string;
  fetchImpl?: typeof fetch;
}

export function createGa4DataClient(deps: Ga4DataClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const propertyId = propertyIdSchema.parse(deps.propertyId);
  const getToken = memoizeToken(deps.getToken);

  return {
    async runReport(request: Ga4RunReportRequest): Promise<Ga4RunReportResponse> {
      await acquireDataSem(propertyId);
      try {
        const token = await getToken().catch((err) => {
          throw new Ga4TokenError("Could not mint a Google Analytics access token.", err);
        });

        const doFetch = async (): Promise<Response> => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30_000);
          try {
            return await fetchImpl(`${GA4_DATA_API_BASE}/${propertyId}:runReport`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(request),
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        };

        let response: Response;
        try {
          response = await doFetch();
        } catch (err) {
          if (isAbortError(err)) throw err;
          // retry once
          await sleep(RETRY_DELAY_MS);
          try {
            response = await doFetch();
          } catch (err2) {
            if (isAbortError(err2)) throw err2;
            throw new Ga4DataApiError(0, "Google Analytics reporting is temporarily unavailable.");
          }
        }

        if (!response.ok) {
          if (response.status >= 500 && response.status < 600) {
            await sleep(RETRY_DELAY_MS);
            let response2: Response;
            try {
              response2 = await doFetch();
            } catch (err) {
              if (isAbortError(err)) throw err;
              throw new Ga4DataApiError(0, "Google Analytics reporting is temporarily unavailable.");
            }
            if (!response2.ok) {
              const body = await response2.text().then((b) => b.slice(0, MAX_ERROR_BODY_LENGTH)).catch(() => "");
              let upstreamReason: string | null = null;
              try {
                const parsed = googleErrorSchema.safeParse(JSON.parse(body));
                if (parsed.success) {
                  upstreamReason =
                    parsed.data.error.details?.find((d) => d.metadata?.service === "analyticsdata.googleapis.com")?.reason ??
                    parsed.data.error.details?.find((d) => d.reason)?.reason ??
                    null;
                }
              } catch {
                // ignore
              }
              throw new Ga4DataApiError(response2.status, dataMessageForStatus(response2.status), safeRetryAfter(response2), upstreamReason);
            }
            response = response2;
          } else {
            const body = await response.text().then((b) => b.slice(0, MAX_ERROR_BODY_LENGTH)).catch(() => "");
            let upstreamReason: string | null = null;
            try {
              const parsed = googleErrorSchema.safeParse(JSON.parse(body));
              if (parsed.success) {
                upstreamReason =
                  parsed.data.error.details?.find((d) => d.metadata?.service === "analyticsdata.googleapis.com")?.reason ??
                  parsed.data.error.details?.find((d) => d.reason)?.reason ??
                  null;
              }
            } catch {
              // ignore
            }
            throw new Ga4DataApiError(response.status, dataMessageForStatus(response.status), safeRetryAfter(response), upstreamReason);
          }
        }

        try {
          return runReportResponseSchema.parse(await response.json());
        } catch {
          throw new Ga4MalformedResponseError();
        }
      } finally {
        releaseDataSem(propertyId);
      }
    },
  };
}
