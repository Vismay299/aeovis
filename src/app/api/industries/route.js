import { NextResponse } from "next/server";
import { INDUSTRY_PROMPTS } from "@/shared/industries";

export async function GET() {
  const industries = Object.keys(INDUSTRY_PROMPTS).map((key) => ({
    id: key,
    label: INDUSTRY_PROMPTS[key].label,
    prompts: INDUSTRY_PROMPTS[key].prompts,
  }));

  return NextResponse.json({ industries });
}
