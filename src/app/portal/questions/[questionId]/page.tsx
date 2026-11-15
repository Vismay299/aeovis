"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/ai-visibility/prompts/$promptId.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useParams } from "next/navigation";
import { QuestionHistoryPage } from "@/components/portal/questions/history/QuestionHistoryPage";

export default function QuestionHistoryRoute() {
  const params = useParams<{ questionId: string }>();
  return <QuestionHistoryPage questionId={params?.questionId || ""} />;
}
