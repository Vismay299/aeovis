import type {
  ExploreModel,
  ExploreObservationRow,
  ExploreRunCreate,
  ExploreRunPatch,
  ExploreRunRow,
  ExploreRunSummary,
  ExploreStore,
  ReusableExploreObservation,
  SeedExploreRow,
} from "./store.ts";

type MemoryExploreSeed = {
  now?: () => number;
  runs?: ExploreRunRow[];
  observations?: ExploreObservationRow[];
};

export type MemoryExploreStore = ExploreStore & {
  runs: Map<string, ExploreRunRow>;
  observations: Map<string, ExploreObservationRow>;
  seedRun(row: ExploreRunRow): void;
  seedObservation(row: ExploreObservationRow): void;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function copyRun(row: ExploreRunRow): ExploreRunRow {
  return {
    ...row,
    models: [...row.models],
    plan: copy(row.plan),
    quote: copy(row.quote),
  };
}

function summary(row: ExploreRunRow): ExploreRunSummary {
  return {
    id: row.id,
    prompt: row.prompt,
    models: [...row.models],
    status: row.status,
    created_at: row.created_at,
    question_id: row.question_id,
  };
}

export function createMemoryExploreStore(seed: MemoryExploreSeed = {}): MemoryExploreStore {
  const now = seed.now ?? Date.now;
  const runs = new Map(seed.runs?.map((row) => [row.id, copyRun(row)]) ?? []);
  const observations = new Map(seed.observations?.map((row) => [row.id, copy(row)]) ?? []);

  return {
    runs,
    observations,

    seedRun(row) {
      runs.set(row.id, copyRun(row));
    },

    seedObservation(row) {
      observations.set(row.id, copy(row));
    },

    async createRun(row: ExploreRunCreate) {
      if (runs.has(row.id)) throw new Error("explore_run_duplicate");
      const created: ExploreRunRow = {
        ...copy(row),
        created_at: row.created_at ?? new Date(now()).toISOString(),
      };
      runs.set(created.id, created);
      return copyRun(created);
    },

    async getRun(brandKey, runId) {
      const row = runs.get(runId);
      return row?.brand_key === brandKey ? copyRun(row) : null;
    },

    async updateRun(brandKey, runId, patch: ExploreRunPatch) {
      const row = runs.get(runId);
      if (!row || row.brand_key !== brandKey) return null;
      const updated = { ...row, ...copy(patch) };
      runs.set(runId, updated);
      return copyRun(updated);
    },

    async deleteRun(brandKey, runId) {
      const row = runs.get(runId);
      if (!row || row.brand_key !== brandKey) return false;
      return runs.delete(runId);
    },

    async listRuns(brandKey, input) {
      const cursorMs = input.cursor ? Date.parse(input.cursor) : Number.POSITIVE_INFINITY;
      const matching = [...runs.values()]
        .filter((row) => row.brand_key === brandKey && Date.parse(row.created_at) < cursorMs)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, input.limit + 1);
      const hasMore = matching.length > input.limit;
      const page = matching.slice(0, input.limit);
      return {
        runs: page.map(summary),
        nextCursor: hasMore ? page.at(-1)?.created_at ?? null : null,
      };
    },

    async seedExplore(rows: SeedExploreRow[]) {
      for (const row of rows) {
        if (row.purpose !== "explore" || row.job_id !== null)
          throw new Error("explore rows only");
        const prior = observations.get(row.id);
        if (prior) {
          const same =
            prior.purpose === row.purpose &&
            prior.job_id === row.job_id &&
            prior.engine === row.engine &&
            prior.query === row.query &&
            canonical(prior.context) === canonical(row.context) &&
            prior.config_version === row.config_version &&
            prior.circuit_key === row.circuit_key &&
            prior.brand_key === row.brand_key;
          if (!same) throw new Error("immutable observation identity mismatch");
          continue;
        }
        observations.set(row.id, {
          ...copy(row),
          state: "pending",
          attempt_count: 0,
          next_attempt_at: new Date(now()).toISOString(),
          lease_token: null,
          lease_until: null,
          reason: null,
          result: null,
          observed_at: null,
          total_cost: 0,
          unknown_cost_calls: 0,
          created_at: new Date(now()).toISOString(),
        });
      }
    },

    async listRunObservations(brandKey, runId) {
      return [...observations.values()]
        .filter(
          (row) =>
            row.purpose === "explore" &&
            row.brand_key === brandKey &&
            row.context.explore_run_id === runId,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map(copy);
    },

    async findReusable(input) {
      const nowMs = input.now === undefined ? now() : new Date(input.now).getTime();
      const cutoffMs = nowMs - input.days * 86_400_000;
      const result = new Map<ExploreModel, ReusableExploreObservation>();
      for (const route of input.routes) {
        if (!route.route || !route.modelName) continue;
        const found = [...observations.values()]
          .filter((row) => {
            const observedMs = row.observed_at === null ? Number.NaN : Date.parse(row.observed_at);
            return (
              row.purpose === "explore" &&
              row.brand_key === input.brandKey &&
              row.engine === route.model &&
              row.context.prompt_hash === input.promptHash &&
              row.state === "answered" &&
              observedMs > cutoffMs &&
              String(row.context.web_search) === String(input.webSearch) &&
              String(row.context.country ?? "") === String(input.country ?? "") &&
              row.context.model_name === route.modelName &&
              row.context.route === route.route &&
              typeof row.context.explore_run_id === "string"
            );
          })
          .sort((a, b) => Date.parse(b.observed_at ?? "") - Date.parse(a.observed_at ?? ""));
        const row = found[0];
        if (!row?.observed_at) continue;
        result.set(route.model, {
          observationId: row.id,
          runId: String(row.context.explore_run_id),
          observedAt: row.observed_at,
          configVersion: row.config_version,
        });
      }
      return result;
    },
  };
}
