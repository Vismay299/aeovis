import { terminalOutcomeFromRecord } from "./scanOutcome.js";

export function scanCompletionNotice(record) {
  const outcome = terminalOutcomeFromRecord(record);
  const messages = {
    complete: { tone: "success", title: "Scan complete", message: "All planned observations were collected. View the report for metric qualification." },
    partial: { tone: "warn", title: "Partial collection", message: "Some planned observations could not be collected. Review the report's coverage and failure reasons before drawing conclusions." },
    failed: { tone: "error", title: "Collection failed", message: "No usable observations were collected. Review the provider failure reasons before starting another paid scan." },
    blocked: { tone: "error", title: "Collection blocked", message: "Collection was blocked by configuration or budget controls. Review the report's recovery conditions before another paid scan." },
  };
  return messages[outcome.outcome] || { tone: "info", title: "Report saved; collection quality unknown", message: "This report has no verified modern collection outcome. Review its evidence before using the results." };
}
