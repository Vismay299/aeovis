export function scoreTier(score, scoringVersion = "v2-composite") {
  const isBinary = scoringVersion === "v1-binary";
  const strongThreshold = isBinary ? 70 : 50;
  const moderateThreshold = isBinary ? 40 : 25;

  if (score >= strongThreshold) return "strong";
  if (score >= moderateThreshold) return "moderate";
  return "weak";
}

export function tierLabel(tier) {
  return { strong: "Strong", moderate: "Moderate", weak: "Weak" }[tier] || "—";
}

export function tierClasses(tier) {
  switch (tier) {
    case "strong":
      return "text-[var(--good)] border-[var(--good-border)]";
    case "moderate":
      return "text-[var(--warn)] border-[var(--warn-border)]";
    case "weak":
      return "text-[var(--crit)] border-[var(--crit-border)]";
    default:
      return "text-[var(--text-2)] border-[var(--border-2)]";
  }
}

export function formatTimestamp(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function relativeTime(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function rankColor(rank) {
  if (rank === "—" || rank == null) return "text-[#999999]";
  if (rank <= 2) return "text-[#2F5C4F]";
  if (rank <= 4) return "text-[#8F6614]";
  return "text-[#8B3A3A]";
}
