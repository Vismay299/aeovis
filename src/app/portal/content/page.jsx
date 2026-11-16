"use client";

import { Suspense } from "react";
import ContentStudio from "@/components/portal/content/ContentStudio";

export default function ContentStudioPage() {
  return (
    <Suspense fallback={null}>
      <ContentStudio />
    </Suspense>
  );
}
