import { NextResponse } from "next/server";
import { listAgents, insertAgent } from "@/server/db/content";
import { normalizeAgent } from "@/shared/content/agents/model";
import { FORMATS } from "@/shared/content/agents/formats";
import { CREW } from "@/shared/content/agents/crew";
import { BLOCKS, DEFAULT_PIPELINES } from "@/shared/content/agents/blocks";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/agents?brand= — the brand's agents (seeds built-ins on first call),
 * plus the format catalog and crew roster so the builder UI is self-describing.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = (searchParams.get("brand") || "").trim();
    if (!brand) {
      return NextResponse.json({ detail: "brand query param is required." }, { status: 400 });
    }

    const agents = await listAgents(brand);
    const formats = Object.values(FORMATS).map((f) => ({
      key: f.key,
      label: f.label,
      emoji: f.emoji,
      base: f.base,
      blurb: f.blurb,
      length_hint: f.length_hint,
      config_schema: f.config_schema || null,
    }));

    const blocks = Object.values(BLOCKS).map((b) => ({
      slug: b.slug,
      name: b.name,
      emoji: b.emoji,
      role: b.role,
      kind: b.kind,
      verb: b.verb,
      blurb: b.blurb,
      locked: b.locked === true,
      config_schema: b.config_schema || null,
    }));

    return NextResponse.json(
      { agents, formats, crew: CREW, blocks, default_pipelines: DEFAULT_PIPELINES },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Agents GET error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** POST /api/agents — create a custom agent { brand, ...agentFields }. */
export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    if (!brand) {
      return NextResponse.json({ detail: "brand is required." }, { status: 400 });
    }

    const { ok, errors, agent } = normalizeAgent(payload, brand);
    if (!ok) {
      return NextResponse.json({ detail: errors.join("; ") }, { status: 400 });
    }
    agent.is_builtin = false; // user-created agents are never built-in

    const saved = await insertAgent(brand, agent);
    return NextResponse.json({ agent: saved }, { status: 201 });
  } catch (error) {
    console.error("Agents POST error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
