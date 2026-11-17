// @ts-nocheck
// Hand-written in-memory Supabase stand-in for the F22 P4 tests. It implements
// only the PostgREST surface the assistant repositories use: select/insert/
// update/delete with eq/is/lt/gt/gte/order/limit, maybeSingle/single, and the
// handful of RPCs from migrations 145–148. No network, no real database.

const TABLES = [
  "assistant_sessions",
  "assistant_messages",
  "assistant_turns",
  "assistant_stream_chunks",
  "assistant_approvals",
];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function createFakeAdmin(seed = {}) {
  const tables = new Map();
  for (const name of TABLES) tables.set(name, []);
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, (rows ?? []).map((row) => clone(row)));
  }
  const rpcHandlers = new Map();
  const rpcCalls = [];
  const queryCalls = [];
  const ops = [];
  let seqCounter = Math.max(0, ...[...tables.get("assistant_messages")].map((row) => Number(row.seq ?? 0)));
  let clock = seed.now ?? (() => Date.now());

  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };

  function matches(row, filters) {
    return filters.every(([column, op, value]) => {
      const current = row[column];
      if (op === "is") return value === null ? current === null || current === undefined : current === value;
      if (op === "lt") return current !== null && current !== undefined && current < value;
      if (op === "lte") return current !== null && current !== undefined && current <= value;
      if (op === "gt") return current !== null && current !== undefined && current > value;
      if (op === "gte") return current !== null && current !== undefined && current >= value;
      return current === value;
    });
  }

  function defaultsFor(table, row) {
    const at = iso(clock());
    const base = { ...row };
    if (table === "assistant_sessions") {
      base.id ??= crypto.randomUUID();
      base.title ??= "New chat";
      base.summary ??= null;
      base.compacted_through_seq ??= null;
      base.kickoff ??= null;
      base.archived_at ??= null;
      base.created_at ??= at;
      base.updated_at ??= at;
    } else if (table === "assistant_messages") {
      base.id ??= crypto.randomUUID();
      base.seq ??= (seqCounter += 1);
      base.parts ??= [];
      base.metadata ??= {};
      base.turn_id ??= null;
      base.created_at ??= at;
    } else if (table === "assistant_turns") {
      base.id ??= crypto.randomUUID();
      base.status ??= "streaming";
      base.stop_reason ??= null;
      base.user_message_id ??= null;
      base.assistant_message_id ??= null;
      base.model ??= null;
      base.steps ??= 0;
      base.tool_calls ??= 0;
      base.input_tokens ??= null;
      base.output_tokens ??= null;
      base.cost_usd ??= null;
      base.cost_known ??= false;
      base.compacted ??= false;
      base.error_code ??= null;
      base.cancel_requested_at ??= null;
      base.started_at ??= at;
      base.heartbeat_at ??= at;
      base.finished_at ??= null;
    } else if (table === "assistant_stream_chunks") {
      base.seq ??= 0;
      base.created_at ??= at;
    } else if (table === "assistant_approvals") {
      base.id ??= crypto.randomUUID();
      base.status ??= "pending";
      base.result ??= null;
      base.error_code ??= null;
      base.decided_at ??= null;
      base.finished_at ??= null;
      base.approved_max_usd ??= null;
      base.quote ??= null;
      base.quote_input ??= null;
      base.priced_action ??= null;
      base.created_at ??= at;
    }
    return base;
  }

  function uniquenessError(table, row, existing) {
    if (table === "assistant_approvals") {
      const clash = existing.some(
        (candidate) =>
          candidate.session_id === row.session_id && candidate.tool_call_id === row.tool_call_id,
      );
      if (clash) return { code: "23505", message: "duplicate key value violates unique constraint" };
    }
    if (table === "assistant_messages") {
      const clash = existing.some(
        (candidate) => candidate.session_id === row.session_id && candidate.id === row.id,
      );
      if (clash) return { code: "23505", message: "duplicate key value violates unique constraint" };
    }
    if (table === "assistant_stream_chunks") {
      const clash = existing.some(
        (candidate) => candidate.turn_id === row.turn_id && Number(candidate.seq) === Number(row.seq),
      );
      if (clash) return { code: "23505", message: "duplicate key value violates unique constraint" };
    }
    return null;
  }

  function runQuery(table, state) {
    const rows = rowsOf(table);
    if (state.action?.kind === "insert") {
      const inserted = [];
      for (const raw of state.action.rows) {
        const row = defaultsFor(table, raw);
        const duplicate = uniquenessError(table, row, rows);
        if (duplicate) return { data: null, error: duplicate };
        rows.push(row);
        inserted.push(clone(row));
      }
      return { data: inserted, error: null };
    }
    if (state.action?.kind === "update") {
      const hit = rows.filter((row) => matches(row, state.filters));
      for (const row of hit) Object.assign(row, clone(state.action.patch));
      return { data: hit.map(clone), error: null };
    }
    if (state.action?.kind === "delete") {
      const hit = rows.filter((row) => matches(row, state.filters));
      for (const row of hit) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
      return { data: hit.map(clone), error: null };
    }
    let out = rows.filter((row) => matches(row, state.filters));
    for (const [column, ascending] of [...state.orders].reverse()) {
      out = out.slice().sort((a, b) => {
        if (a[column] === b[column]) return 0;
        return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (state.limit !== null) out = out.slice(0, state.limit);
    return { data: out.map(clone), error: null };
  }

  function from(table) {
    const state = { action: null, filters: [], orders: [], limit: null };
    const settle = (mode) => {
      queryCalls.push({ table, action: state.action?.kind ?? "select", filters: [...state.filters] });
      ops.push({ table, action: state.action?.kind ?? "select" });
      const result = runQuery(table, state);
      if (mode === "maybe") {
        return { data: result.error ? null : (result.data?.[0] ?? null), error: result.error };
      }
      if (mode === "one") {
        if (result.error) return { data: null, error: result.error };
        if (!result.data || result.data.length === 0) {
          return { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: result.data[0], error: null };
      }
      return result;
    };
    const builder = {
      select() {
        if (!state.action) state.action = { kind: "select" };
        return builder;
      },
      insert(row) {
        state.action = { kind: "insert", rows: Array.isArray(row) ? row : [row] };
        return builder;
      },
      update(patch) {
        state.action = { kind: "update", patch };
        return builder;
      },
      delete() {
        state.action = { kind: "delete" };
        return builder;
      },
      eq(column, value) {
        state.filters.push([column, "eq", value]);
        return builder;
      },
      is(column, value) {
        state.filters.push([column, "is", value]);
        return builder;
      },
      lt(column, value) {
        state.filters.push([column, "lt", value]);
        return builder;
      },
      lte(column, value) {
        state.filters.push([column, "lte", value]);
        return builder;
      },
      gt(column, value) {
        state.filters.push([column, "gt", value]);
        return builder;
      },
      gte(column, value) {
        state.filters.push([column, "gte", value]);
        return builder;
      },
      order(column, opts = {}) {
        state.orders.push([column, opts.ascending !== false]);
        return builder;
      },
      limit(n) {
        state.limit = n;
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(settle("maybe"));
      },
      single() {
        return Promise.resolve(settle("one"));
      },
      then(resolve, reject) {
        return Promise.resolve(settle("many")).then(resolve, reject);
      },
    };
    return builder;
  }

  const defaultRpc = (name, args) => {
    const at = iso(clock());
    if (name === "begin_assistant_turn") {
      const sessions = rowsOf("assistant_sessions");
      const session = sessions.find(
        (row) =>
          row.id === args.p_session &&
          row.brand_key === args.p_brand &&
          row.user_id === args.p_user &&
          (row.archived_at === null || row.archived_at === undefined),
      );
      if (!session) return { data: null, error: { message: "session_not_found" } };
      const turns = rowsOf("assistant_turns");
      for (const turn of turns) {
        if (
          turn.session_id === args.p_session &&
          turn.status === "streaming" &&
          turn.heartbeat_at < iso(clock() - 90_000)
        ) {
          turn.status = "interrupted";
          turn.stop_reason = "interrupted";
          turn.finished_at = at;
        }
      }
      if (turns.some((turn) => turn.session_id === args.p_session && turn.status === "streaming")) {
        return { data: null, error: { message: "turn_in_progress" } };
      }
      const row = defaultsFor("assistant_turns", {
        session_id: args.p_session,
        brand_key: args.p_brand,
        user_id: args.p_user,
      });
      turns.push(row);
      return { data: row.id, error: null };
    }
    if (name === "claim_assistant_approval") {
      const rows = rowsOf("assistant_approvals");
      const row = rows.find(
        (candidate) =>
          candidate.id === args.p_id &&
          candidate.user_id === args.p_user &&
          candidate.brand_key === args.p_brand,
      );
      if (!row) return { data: null, error: { message: "approval_not_found" } };
      if (row.status === "pending" && row.expires_at > at) {
        row.status = "running";
        row.decided_at = at;
        row.approved_max_usd = args.p_max;
        return { data: clone(row), error: null };
      }
      if (row.status === "pending") {
        row.status = "expired";
        return { data: null, error: { message: "approval_expired" } };
      }
      return { data: null, error: { message: "approval_not_pending" } };
    }
    if (name === "rewind_assistant_session") {
      const sessions = rowsOf("assistant_sessions");
      if (!sessions.some((row) => row.id === args.p_session && row.user_id === args.p_user)) {
        return { data: null, error: { message: "session_not_found" } };
      }
      const messages = rowsOf("assistant_messages");
      const target = messages.find(
        (row) => row.session_id === args.p_session && row.id === args.p_message_id,
      );
      if (!target) return { data: null, error: { message: "message_not_found" } };
      let removed = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const row = messages[index];
        if (row.session_id === args.p_session && Number(row.seq) >= Number(target.seq)) {
          messages.splice(index, 1);
          removed += 1;
        }
      }
      const session = sessions.find((row) => row.id === args.p_session);
      if (session && session.compacted_through_seq !== null && Number(session.compacted_through_seq) >= Number(target.seq)) {
        session.summary = null;
        session.compacted_through_seq = null;
      }
      for (const approval of rowsOf("assistant_approvals")) {
        if (
          approval.session_id === args.p_session &&
          approval.status === "pending" &&
          approval.created_at >= target.created_at
        ) {
          approval.status = "expired";
        }
      }
      return { data: removed, error: null };
    }
    if (name === "expire_assistant_approvals") {
      let expired = 0;
      let failed = 0;
      for (const row of rowsOf("assistant_approvals")) {
        if (row.status === "pending" && row.expires_at <= args.p_now) {
          row.status = "expired";
          expired += 1;
        } else if (
          row.status === "running" &&
          row.decided_at &&
          row.decided_at < iso(new Date(args.p_now).getTime() - 10 * 60_000)
        ) {
          row.status = "failed";
          row.error_code = "interrupted";
          row.finished_at = args.p_now;
          failed += 1;
        }
      }
      return { data: { expired, failed }, error: null };
    }
    if (name === "prune_assistant_stream_chunks") {
      const turns = new Map(rowsOf("assistant_turns").map((row) => [row.id, row]));
      const chunks = rowsOf("assistant_stream_chunks");
      let deleted = 0;
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const chunk = chunks[index];
        const turn = turns.get(chunk.turn_id);
        if (
          turn &&
          turn.finished_at !== null &&
          turn.finished_at !== undefined &&
          turn.finished_at < args.p_finished_before &&
          deleted < (args.p_limit ?? 5_000)
        ) {
          chunks.splice(index, 1);
          deleted += 1;
        }
      }
      return { data: deleted, error: null };
    }
    if (name === "prune_assistant_sessions") {
      const sessions = rowsOf("assistant_sessions");
      const old = sessions
        .filter((row) => row.updated_at < args.p_before)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
        .slice(0, args.p_limit ?? 500);
      for (const session of old) {
        for (const table of TABLES) {
          const rows = rowsOf(table);
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (rows[index].session_id === session.id) rows.splice(index, 1);
          }
        }
        const turns = rowsOf("assistant_turns");
        for (let index = turns.length - 1; index >= 0; index -= 1) {
          if (turns[index].session_id === session.id) {
            for (let c = rowsOf("assistant_stream_chunks").length - 1; c >= 0; c -= 1) {
              if (rowsOf("assistant_stream_chunks")[c].turn_id === turns[index].id) {
                rowsOf("assistant_stream_chunks").splice(c, 1);
              }
            }
            turns.splice(index, 1);
          }
        }
        const index = sessions.indexOf(session);
        if (index >= 0) sessions.splice(index, 1);
      }
      return { data: old.length, error: null };
    }
    return { data: null, error: { message: "unknown rpc " + name } };
  };

  return {
    tables,
    rpcCalls,
    queryCalls,
    ops,
    from,
    rpc(name, args) {
      rpcCalls.push({ name, args });
      ops.push({ rpc: name });
      const handler = rpcHandlers.get(name);
      return Promise.resolve(handler ? handler(args) : defaultRpc(name, args));
    },
    setRpc(name, handler) {
      rpcHandlers.set(name, handler);
    },
    setNow(fn) {
      clock = fn;
    },
    rows(table) {
      return rowsOf(table);
    },
  };
}
