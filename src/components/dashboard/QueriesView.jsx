import { Card } from "@/components/perceev/Card";
import { PromptMetricsTable } from "./PromptMetricsTable";
import { SectionStrap } from "./SectionStrap";
import { QueryManager } from "./QueryManager";

/**
 * Queries tab: P2a's per-prompt metrics table ("Prompt performance") sits
 * above the pre-existing QueryManager CRUD tool ("Manage prompts") — the
 * metrics table is a pure read (its own fetch, its own loading/error/empty
 * states; see PromptMetricsTable.jsx), and QueryManager is left completely
 * untouched below it so add/enable/disable prompt management keeps working
 * exactly as it did before.
 */
export const QueriesView = ({ brand, legacyBrand, currentPrompts }) => {
  return (
    <Card variant="flush" style={{ height: "100%", overflow: "auto" }}>
      <PromptMetricsTable brand={brand} />

      <div style={{ borderTop: "1px solid var(--border-1)", marginTop: "var(--space-2)" }}>
        <div style={{ padding: "var(--space-5) var(--space-6) 0" }}>
          <SectionStrap testId="manage-prompts-strap">Manage prompts</SectionStrap>
        </div>
      </div>
      <QueryManager brand={brand} legacyBrand={legacyBrand} currentPrompts={currentPrompts} />
    </Card>
  );
};
