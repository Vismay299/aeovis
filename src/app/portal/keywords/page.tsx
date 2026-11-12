"use client";

import { Suspense } from "react";
import { KeywordResearchPage } from "@/components/portal/keywords/research/KeywordResearchPage";
import { KeywordResearchLoadingState } from "@/components/portal/keywords/research/KeywordResearchLoadingState";

export default function KeywordsPage() {
  return <Suspense fallback={<div className="p-6"><KeywordResearchLoadingState /></div>}><KeywordResearchPage /></Suspense>;
}
