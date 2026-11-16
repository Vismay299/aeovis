"use client";

import { useSnapshotTargets } from "./hooks/useSnapshotTargets";

export function TrackedTargetsList({
  brandKey,
  enabled,
}: {
  brandKey: string;
  enabled: boolean;
}) {
  const query = useSnapshotTargets(brandKey, enabled);
  const targets = query.data?.targets.filter((item) => item.enabled) ?? [];
  if (targets.length === 0) return null;

  return (
    <section className="mb-5 space-y-3" aria-labelledby="tracked-history-list-title">
      <h2 id="tracked-history-list-title" className="text-sm font-semibold">
        Tracked history
      </h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {targets.map((item) => (
          <li key={item.id}>
            <a
              href={`/portal/backlinks?${new URLSearchParams({ target: item.target, scope: item.scope }).toString()}`}
              className="flex w-full flex-col items-start gap-1 p-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-medium">{item.target}</span>
              <span className="text-xs text-muted-foreground">
                {item.interval === "weekly" ? "Weekly" : "Monthly"} · Next snapshot {formatDate(item.nextRunAt)}
              </span>
              {item.lastSkipMessage ? (
                <span className="text-xs text-muted-foreground">{item.lastSkipMessage}</span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
