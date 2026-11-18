import { Suspense } from "react";
import { StatusScreen } from "@/components/app/StatusScreen";
import { AssistantPage } from "@/components/portal/assistant/AssistantPage";

export const dynamic = "force-dynamic";

export default function AssistantRoutePage() {
  return (
    <Suspense fallback={<StatusScreen pending />}>
      <AssistantPage />
    </Suspense>
  );
}
