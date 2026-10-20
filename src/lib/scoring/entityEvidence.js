import { getBrandAliases, ALIAS_STOPLIST } from "./aliases.js";
import { extractBrandDomain } from "./citations.js";
import { findMentionSpans } from "./judgeRelationship.js";

export const ENTITY_RESOLUTION_VERSION = "r05-entity-v1";
const HOMONYMS = new Set(["apple", "target", "box", "shelf", "point", "tool", "tools", "cloud"]);
const owns = (host, domain) => Boolean(domain && (host === domain || host.endsWith(`.${domain}`)));
function domainOf(value) {
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return ["http:", "https:"].includes(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch { return ""; /* A malformed reference is not entity evidence. */ }
}

// Selected rivals are deliberately not an input. The registered entity identity
// and captured text/links are resolved before comparison/display roster selection.
export function resolveEntityEvidence({ brand, website, text = "", references = [], aliases }) {
  const domain = extractBrandDomain(website);
  const entityId = domain ? `domain:${domain}` : `name:${String(brand).trim().toLowerCase()}`;
  // Mask echoed questions without changing offsets into the original capture.
  const answer = String(text).replace(/(?:user(?:\s+asked)?|question|prompt):\s*["'][^"'\n]+["']/gi, match => " ".repeat(match.length));
  const candidates = [...new Map([brand, ...(aliases || getBrandAliases(brand, website))].filter(Boolean).map(a=>[a.toLowerCase(),a])).values()];
  const nameAliases = new Set([brand, ...getBrandAliases(brand, "")].filter(Boolean).map(a=>a.toLowerCase()));
  const distinctive = candidates.filter(a => nameAliases.has(a.toLowerCase()) && !a.includes(".") && a.length > 2 && !HOMONYMS.has(a.toLowerCase()) && !ALIAS_STOPLIST.has(a.toLowerCase()));
  const spans = findMentionSpans(answer, distinctive);
  const domains = [];
  for (const match of answer.matchAll(/(?:https?:\/\/|www\.)[^\s<>"')]+|(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"')]*)?/gi)) {
    const value = match[0].replace(/[.,;!?]+$/, ""), host = domainOf(value);
    if (!host) continue;
    domains.push({ entity_id:`domain:${host}`, domain:host, source:"answer_domain", start:match.index, end:match.index+value.length });
    if (owns(host, domain)) spans.push({ start:match.index, end:match.index+value.length, text:value, alias:domain, source:"owned_domain" });
  }
  const citationEvidence = references.flatMap((ref, index) => {
    const href = typeof ref === "string" ? ref : ref?.href;
    const host = href && domainOf(href);
    return host ? [{ entity_id:`domain:${host}`, domain:host, href, reference_index:index, owned:owns(host,domain) }] : [];
  });
  const mentionSpans = spans.filter(s=>s.source === "owned_domain" || !domains.some(d=>s.start < d.end && s.end > d.start));
  const uncertainAliases = candidates.filter(a => !a.includes(".") && !distinctive.includes(a));
  const ambiguous = mentionSpans.length === 0 && findMentionSpans(answer, uncertainAliases, {allowShortAliases:true}).some(s=>!domains.some(d=>s.start<d.end&&s.end>d.start));
  const state = !answer.trim() ? "text_unobserved" : ambiguous ? "ambiguous" : "observed";
  return {
    version:ENTITY_RESOLUTION_VERSION, entity_id:entityId, identity_source:domain ? "registered_website" : "registered_name",
    mention_state:state, mentioned:state === "observed" ? mentionSpans.length > 0 : null,
    spans:mentionSpans.sort((a,b)=>a.start-b.start), cited:citationEvidence.some(r=>r.owned),
    citation_evidence:citationEvidence, observed_domains:domains,
    reason:ambiguous ? "uncorroborated_generic_or_short_alias" : null,
  };
}

export function applyEntityEvidence(row, {brand, website, aliases}) {
  const evidence = resolveEntityEvidence({brand, website, aliases, text:row.text || row.aio_text || "", references:row.references || row.aio_references || []});
  row.entity_evidence = evidence;
  if(row.error){row.brand_cited=evidence.cited;row.visible=evidence.cited || row.visible===true;return row;}
  row.brand_mentioned_in_text = evidence.mentioned;
  row.brand_cited = evidence.cited;
  row.visible = evidence.cited || (evidence.mentioned === null ? null : evidence.mentioned);
  return row;
}
