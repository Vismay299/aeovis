import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { repairWorkflowStore } from "@/lib/db/repairWorkflow";
import {
  validatePanel,
  makeSourceSnapshot,
  opportunityFromEvidence,
} from "@/lib/repairs/workflow";
import {
  auditOwnedPages,
  boundedResponseText,
} from "@/lib/repairs/technicalAudit";
import { getBrandAliases } from "@/lib/scoring/aliases";
import { safeFetch } from "@/lib/ssrfGuard";
import {
  ensureBackfilled,
  normalizeQuestionText,
  syncPanelQuestions,
} from "@/lib/questions/workspaceQuestions.ts";
export const dynamic = "force-dynamic";
const json = (data, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const kinds = new Set([
  "panel",
  "source_snapshot",
  "opportunity",
  "publication",
  "comparison",
  "calibration",
  "collector_qualification",
  "study",
  "technical_audit",
]);
export async function GET(request, { params }) {
  const { kind } = await params;
  if (!kinds.has(kind)) return json({ error: "Unknown repair resource" }, 404);
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  try {
    return json({
      items: await repairWorkflowStore(getSupabaseAdmin()).list(
        ctx.brand.brandKey,
        kind,
      ),
    });
  } catch {
    return json({ error: "Could not load measurement workflow" }, 503);
  }
}
export async function POST(request, { params }) {
  const { kind } = await params;
  if (
    !["panel", "source_snapshot", "opportunity", "technical_audit"].includes(
      kind,
    )
  )
    return json(
      { error: "Use the dedicated verified workflow for this resource" },
      400,
    );
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Workflow unavailable" }, 503);
  try {
    const text = await request.text();
    if (text.length > 500_000)
      return json({ error: "Request exceeds the import limit" }, 413);
    const body = JSON.parse(text);
    const store = repairWorkflowStore(admin);
    let payload,
      state = body.state || "draft";
    let key = String(body.key || "default");
    const expectedVersion = Number(body.expected_version || 0);
    if (kind === "panel") {
      payload = validatePanel(body.payload, {
        brandAliases: getBrandAliases(ctx.brand.display_name,ctx.brand.website),
      });
      if (!["draft", "approved", "retired"].includes(state))
        throw new Error("Invalid panel state");
      if (
        state === "approved" &&
        (!payload.persona || payload.near_duplicates.length)
      )
        throw new Error(
          "Review persona and near-duplicate questions before approval",
        );
      if (state === "approved") {
        await ensureBackfilled(admin, ctx.brand.brandKey);
        const { ids } = await syncPanelQuestions(admin, {
          brandKey: ctx.brand.brandKey,
          prompts: payload.prompts.map((p) => ({
            text: p.text,
            topic: p.topic,
            purpose: p.purpose,
            origin: p.origin,
          })),
          settings: {
            persona: payload.persona,
            country: payload.context.country,
            language: payload.context.language,
          },
          actor: ctx.user.id,
        });
        const idsByText = new Map(
          ids.map((item) => [normalizeQuestionText(item.text), item.question_id]),
        );
        const idFor = (text) => idsByText.get(normalizeQuestionText(text));
        payload.prompts = payload.prompts.map((p) => ({
          ...p,
          id: idFor(p.text),
          question_id: idFor(p.text),
        }));
      }
      if (state === "retired" && !body.reason)
        throw new Error("Panel retirement needs a relevance rationale");
      payload = {
        ...payload,
        reviewer: ctx.user.id,
        reviewed_at: new Date().toISOString(),
        reason: body.reason || null,
      };
    } else if (kind === "technical_audit") {
      payload = await auditOwnedPages({
        website: ctx.brand.website,
        approvedUrls: body.urls || [],
        maxRequests: 6,
      });
      state = "observed";
    } else if (kind === "source_snapshot") {
      const url = String(body.url || "");
      const response = await safeFetch(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (!response.ok)
        throw new Error(
          "Source page is unavailable; verification remains unresolved",
        );
      const html = await boundedResponseText(response);
      if (html.length > 2_000_000)
        throw new Error("Source exceeds the capture limit");
      payload = makeSourceSnapshot({
        url,
        finalUrl: response.url || url,
        html,
        status: response.status,
      });
      state = "captured";
    } else {
      if (body.action === "review") {
        const prior = await store.get(ctx.brand.brandKey, body.artifact_id);
        if (!prior || prior.kind !== "opportunity")
          return json({ error: "Opportunity not found" }, 404);
        if (
          !["accepted", "dismissed", "corrected"].includes(body.decision) ||
          !body.reason
        )
          throw new Error("Provide a review decision and reason");
        if (
          body.decision === "accepted" &&
          prior.payload.evidence_status !== "verified"
        )
          throw new Error("Qualified work needs verified supporting evidence");
        key = prior.artifact_key;
        payload = {
          ...prior.payload,
          decision: body.decision,
          reviewer: ctx.user.id,
          reviewed_at: new Date().toISOString(),
          decision_reason: body.reason,
        };
        state = body.decision;
      } else {
        const source = await store.get(ctx.brand.brandKey, body.source_id);
        if (!source || source.kind !== "source_snapshot")
          return json({ error: "Source not found" }, 404);
        const ids = Array.isArray(body.observation_ids)
          ? body.observation_ids.slice(0, 100)
          : [];
        const { data: observations, error } = ids.length
          ? await admin
              .from("probe_observations")
              .select("id,engine,observed_at,query,scan_jobs!inner(brand_key)")
              .eq("scan_jobs.brand_key", ctx.brand.brandKey)
              .in("id", ids)
          : { data: [] };
        if (error) throw new Error("Could not load supporting observations");
        payload = opportunityFromEvidence({
          snapshot: source.payload,
          passage: body.passage,
          observations: (observations || []).map((o) => ({
            ...o,
            observation_id: o.id,
            prompt_id: o.query,
            surface: o.engine,
          })),
          targetUrl: body.target_url,
          owner: body.owner,
          mechanism: body.mechanism,
          ownedDomain: ctx.brand.website
            ? new URL(ctx.brand.website).hostname
            : null,
        });
        state = "unreviewed";
      }
    }
    const item = await store.append({
      brand: ctx.brand.brandKey,
      kind,
      key,
      expectedVersion,
      state,
      payload,
      actor: ctx.user.id,
    });
    return json({ item }, 201);
  } catch (error) {
    return json(
      {
        error: /revision conflict/.test(error.message)
          ? "This resource changed; reload before saving."
          : error.message,
      },
      /revision conflict/.test(error.message) ? 409 : 400,
    );
  }
}
