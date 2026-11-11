import type { SupabaseClient } from "@supabase/supabase-js";

export type ExploreModel = "chatgpt" | "gemini" | "perplexity";
export type ExploreRunStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type ExplorePlanEntry = {
  model: ExploreModel;
  route: "dataforseo" | "openrouter" | null;
  modelName: string | null;
  reserveUsd: number;
  skipped: "UNSUPPORTED_COUNTRY" | "NOT_AVAILABLE" | null;
  reusedFrom: { observationId: string; runId: string; observedAt: string } | null;
  observationId: string;
};

export type ExploreRunRow = {
  id: string;
  brand_key: string;
  created_by: string | null;
  job_id: string | null;
  prompt: string;
  prompt_hash: string;
  models: ExploreModel[];
  web_search: boolean;
  country: string | null;
  highlight_brand: string | null;
  status: ExploreRunStatus;
  plan: ExplorePlanEntry[];
  quote: unknown;
  approved_max_usd: number;
  hold_id: string | null;
  question_id: string | null;
  created_at: string;
  finished_at: string | null;
};

export type ExploreRunSummary = Pick<
  ExploreRunRow,
  "id" | "prompt" | "models" | "status" | "created_at" | "question_id"
>;

export type ExploreRunCreate = Omit<ExploreRunRow, "created_at"> & { created_at?: string };
export type ExploreRunPatch = Partial<Pick<ExploreRunRow, "job_id" | "status" | "plan" | "finished_at" | "question_id">>;

export type ExploreRoute = {
  model: ExploreModel;
  route: "dataforseo" | "openrouter" | null;
  modelName: string | null;
};

export type SeedExploreRow = {
  id: string;
  purpose: "explore";
  job_id: null;
  engine: ExploreModel;
  query: string;
  context: Record<string, unknown>;
  config_version: string;
  circuit_key: string;
  deadline_at: string;
  brand_key: string;
};

export type ExploreObservationRow = {
  id: string;
  job_id: string | null;
  purpose: "explore" | "scan" | "canary";
  engine: string;
  query: string;
  context: Record<string, unknown>;
  config_version: string;
  circuit_key: string;
  state: string;
  attempt_count: number;
  next_attempt_at: string;
  deadline_at: string;
  lease_token: string | null;
  lease_until: string | null;
  reason: string | null;
  result: unknown;
  observed_at: string | null;
  total_cost: number;
  unknown_cost_calls: number;
  created_at: string;
  brand_key: string | null;
};

export type ReusableExploreObservation = {
  observationId: string;
  runId: string;
  observedAt: string;
  configVersion: string;
};

export type ExploreStore = {
  createRun(row: ExploreRunCreate): Promise<ExploreRunRow>;
  getRun(brandKey: string, runId: string): Promise<ExploreRunRow | null>;
  updateRun(brandKey: string, runId: string, patch: ExploreRunPatch): Promise<ExploreRunRow | null>;
  deleteRun(brandKey: string, runId: string): Promise<boolean>;
  listRuns(brandKey: string, input: { limit: number; cursor?: string }): Promise<{
    runs: ExploreRunSummary[];
    nextCursor: string | null;
  }>;
  seedExplore(rows: SeedExploreRow[]): Promise<void>;
  listRunObservations(brandKey: string, runId: string): Promise<ExploreObservationRow[]>;
  findReusable(input: {
    brandKey: string;
    promptHash: string;
    routes: ExploreRoute[];
    webSearch: boolean;
    country: string | null;
    days: number;
    now?: Date | string | number;
  }): Promise<Map<ExploreModel, ReusableExploreObservation>>;
};

function rowsFrom(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function rowRunId(row: Record<string, unknown>): string | null {
  const context = row.context;
  if (!context || typeof context !== "object") return null;
  const runId = (context as Record<string, unknown>).explore_run_id;
  return typeof runId === "string" ? runId : null;
}

export function createExploreStore(admin: SupabaseClient): ExploreStore {
  return {
    async createRun(row) {
      const { data, error } = await admin.from("explore_runs").insert(row).select("*").single();
      if (error) throw error;
      return data as unknown as ExploreRunRow;
    },

    async getRun(brandKey, runId) {
      const { data, error } = await admin
        .from("explore_runs")
        .select("*")
        .eq("id", runId)
        .eq("brand_key", brandKey)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as ExploreRunRow | null) ?? null;
    },

    async updateRun(brandKey, runId, patch) {
      const { data, error } = await admin
        .from("explore_runs")
        .update(patch)
        .eq("id", runId)
        .eq("brand_key", brandKey)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as ExploreRunRow | null) ?? null;
    },

    async deleteRun(brandKey, runId) {
      const { data, error } = await admin
        .from("explore_runs")
        .delete()
        .eq("id", runId)
        .eq("brand_key", brandKey)
        .select("id");
      if (error) throw error;
      return rowsFrom(data).length > 0;
    },

    async listRuns(brandKey, input) {
      let query = admin
        .from("explore_runs")
        .select("id,prompt,models,status,created_at,question_id")
        .eq("brand_key", brandKey)
        .order("created_at", { ascending: false });
      if (input.cursor) query = query.lt("created_at", input.cursor);
      const { data, error } = await query.limit(input.limit + 1);
      if (error) throw error;
      const found = rowsFrom(data) as unknown as ExploreRunSummary[];
      const hasMore = found.length > input.limit;
      const runs = found.slice(0, input.limit);
      return {
        runs,
        nextCursor: hasMore ? runs.at(-1)?.created_at ?? null : null,
      };
    },

    async seedExplore(rows) {
      if (rows.length === 0) return;
      const { error } = await admin.rpc("seed_explore_observations", { p_rows: rows });
      if (error) throw error;
    },

    async listRunObservations(brandKey, runId) {
      const { data, error } = await admin
        .from("probe_observations")
        .select("*")
        .eq("purpose", "explore")
        .eq("brand_key", brandKey)
        .eq("context->>explore_run_id", runId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return rowsFrom(data) as unknown as ExploreObservationRow[];
    },

    async findReusable(input) {
      const now = input.now === undefined ? Date.now() : new Date(input.now).getTime();
      const cutoff = new Date(now - input.days * 86_400_000).toISOString();
      const reusable = new Map<ExploreModel, ReusableExploreObservation>();

      await Promise.all(input.routes.map(async (route) => {
        if (!route.route || !route.modelName) return;
        let query = admin
          .from("probe_observations")
          .select("id,context,observed_at,config_version")
          .eq("purpose", "explore")
          .eq("brand_key", input.brandKey)
          .eq("engine", route.model)
          .eq("context->>prompt_hash", input.promptHash)
          .eq("state", "answered")
          .gt("observed_at", cutoff)
          .eq("context->>web_search", String(input.webSearch))
          .eq("context->>model_name", route.modelName)
          .eq("context->>route", route.route)
          .order("observed_at", { ascending: false })
          .limit(1);
        if (input.country === null) {
          query = query.or("context->>country.is.null,context->>country.eq.");
        } else {
          query = query.eq("context->>country", input.country);
        }
        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        const row = data as Record<string, unknown> | null;
        const runId = row ? rowRunId(row) : null;
        if (!row || !runId || typeof row.id !== "string" || typeof row.observed_at !== "string") return;
        reusable.set(route.model, {
          observationId: row.id,
          runId,
          observedAt: row.observed_at,
          configVersion: typeof row.config_version === "string" ? row.config_version : "",
        });
      }));

      return reusable;
    },
  };
}
