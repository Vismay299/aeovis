import { supabase } from "../db.js";
import { artifactHash } from "../repairs/workflow.js";
export function repairWorkflowStore(client = supabase) {
  if (!client) throw new Error("Repair workflow requires the service database");
  return {
    async get(brand, id) {
      const { data, error } = await client
        .from("repair_artifacts")
        .select("*")
        .eq("brand", brand)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async list(brand, kind) {
      const { data, error } = await client
        .from("repair_artifact_heads")
        .select(
          "artifact_key,version,artifact:repair_artifacts!repair_artifact_heads_artifact_id_fkey(*)",
        )
        .eq("brand", brand)
        .eq("kind", kind);
      if (error) throw error;
      return (data || []).map((row) => row.artifact);
    },
    async append({
      brand,
      kind,
      key,
      expectedVersion = 0,
      state,
      payload,
      actor = null,
    }) {
      const { data, error } = await client.rpc("append_repair_artifact", {
        p_brand: brand,
        p_kind: kind,
        p_key: key,
        p_expected: expectedVersion,
        p_state: state,
        p_payload: payload,
        p_hash: artifactHash(payload),
        p_actor: actor,
      });
      if (error) throw error;
      return data;
    },
    async publish(args) {
      const { data, error } = await client.rpc(
        "record_verified_publication",
        args,
      );
      if (error) throw error;
      return data;
    },
  };
}
