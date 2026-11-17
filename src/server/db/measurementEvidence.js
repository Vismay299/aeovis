import { createHash } from "node:crypto";
import { supabase } from "../db.js";
import { redactSecrets } from "../../shared/provenance.js";
import { EVIDENCE_BUCKET } from "../evidenceRetention.js";
import {evidenceRedactionStatus} from "../evidenceRedaction.js";

export const EVIDENCE_SCHEMA = "measurement-evidence-v1";
export const MAX_EVIDENCE_BYTES = 2_000_000;
async function bounded(operation, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Evidence storage deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Only response material is accepted. Request headers, cookies, account keys
// and private browser session state never enter the evidence payload.
export function evidenceDocument({
  payload,
  provider,
  surface,
  requestId = null,
  parserVersion = null,
  capturedAt = new Date().toISOString(),
}) {
  const doc = redactSecrets({
    schema: EVIDENCE_SCHEMA,
    redaction_version: "structured-json-v2",
    provider,
    surface,
    provider_request_id: requestId,
    parser_version: parserVersion,
    captured_at: capturedAt,
    payload,
  });
  const body = JSON.stringify(doc);
  if(!evidenceRedactionStatus(doc).safe)throw new Error("Evidence redaction could not be verified");
  if (Buffer.byteLength(body) > MAX_EVIDENCE_BYTES)
    throw new Error("Provider evidence exceeds the capture limit");
  return {
    document: doc,
    body,
    hash: createHash("sha256").update(body).digest("hex"),
  };
}

export function createMeasurementEvidenceStore(client = supabase) {
  if (!client)
    throw new Error("Evidence storage requires the service database");
  async function persist(row) {
    const request = client
      .from("measurement_evidence")
      .upsert(row, {
        onConflict: "observation_id,attempt_token,capture_index",
      });
    const { error } = await bounded(
      request.abortSignal
        ? request.abortSignal(AbortSignal.timeout(10_000))
        : request,
    );
    if (error) throw new Error("Could not persist evidence state");
  }
  return {
    async capture({ observationId, token, index = 0, ...input }) {
      const id = {
        observation_id: observationId,
        attempt_token: token,
        capture_index: index,
      };
      await persist({ ...id, state: "pending", surface: input.surface });
      let stored;
      try {
        stored = evidenceDocument(input);
        const path = `measurements/${observationId}/${token}/${index}-${stored.hash}.json`;
        const { error } = await bounded(
          client.storage
            .from(EVIDENCE_BUCKET)
            .upload(path, stored.body, {
              contentType: "application/json",
              upsert: true,
            }),
        );
        if (error) throw new Error("Evidence object upload failed");
        await persist({
          ...id,
          state: "stored",
          surface: input.surface,
          object_key: path,
          sha256: stored.hash,
          captured_at: stored.document.captured_at,
          expires_at: new Date(
            Date.parse(stored.document.captured_at) + 90 * 86400_000,
          ).toISOString(),
          reason: null,
        });
        return { state: "stored", object_key: path, sha256: stored.hash };
      } catch {
        await persist({
          ...id,
          state: "write_failed",
          surface: input.surface,
          reason: "capture_write_failed",
          sha256: stored?.hash || null,
        });
        return { state: "write_failed", reason: "capture_write_failed" };
      }
    },
    async incident({
      observationId,
      engine,
      parserVersion,
      shape,
      kind = "parser_drift",
    }) {
      const { error } = await client.rpc("record_measurement_incident", {
        p_observation: observationId,
        p_engine: engine,
        p_kind: kind,
        p_parser: parserVersion || "unknown",
        p_shape: createHash("sha256")
          .update(String(shape || "unknown"))
          .digest("hex"),
      });
      if (error) throw new Error("Could not deliver measurement incident");
    },
  };
}
