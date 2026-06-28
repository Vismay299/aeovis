export function scoreTier(score) {
  if (score >= 70) return "strong";
  if (score >= 40) return "moderate";
  return "weak";
}

export function tierLabel(tier) {
  return { strong: "Strong", moderate: "Moderate", weak: "Weak" }[tier] || "—";
}

export function tierClasses(tier) {
  switch (tier) {
    case "strong":
      return "bg-[#E8F0ED] text-[#2F5C4F] border-[#B4D4CA]";
    case "moderate":
      return "bg-[#FDF6E3] text-[#8F6614] border-[#E6D5A7]";
    case "weak":
      return "bg-[#F9ECEC] text-[#8B3A3A] border-[#E2B8B8]";
    default:
      return "bg-[#F3F0E6] text-[#666666] border-[#E5E2D9]";
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
