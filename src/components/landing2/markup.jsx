/**
 * Split an answer into tokens, marking every brand the sample names.
 *
 * Returns [{ t: "word" | "space" | "you" | "rival", v }]. Brand tokens are kept
 * whole so a highlight never breaks across a name; plain text is split into
 * words so it can be revealed word by word.
 */

import { BRAND, RIVAL_NAMES } from "./sample";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NAMES = [BRAND, ...RIVAL_NAMES].sort((a, b) => b.length - a.length);
const PATTERN = new RegExp(`(${NAMES.map(escape).join("|")})`, "g");

/* `youNamed` is the row's own verdict. When the answer mentions the brand only
   to say it is absent, the name is marked as absent rather than lit. */
export function tokenize(text, { youNamed = true } = {}) {
  const out = [];
  for (const part of text.split(PATTERN)) {
    if (!part) continue;
    if (part === BRAND) { out.push({ t: youNamed ? "you" : "absent", v: part }); continue; }
    if (RIVAL_NAMES.includes(part)) { out.push({ t: "rival", v: part }); continue; }
    for (const bit of part.split(/(\s+)/)) {
      if (!bit) continue;
      out.push({ t: /^\s+$/.test(bit) ? "space" : "word", v: bit });
    }
  }
  return out;
}

export function Tokens({ tokens, className = "" }) {
  return tokens.map((tok, i) => {
    if (tok.t === "space") return " ";
    if (tok.t === "you") return <mark key={i} className={`lp2-mark lp2-mark--you lp2-w ${className}`}>{tok.v}</mark>;
    if (tok.t === "absent") return <mark key={i} className={`lp2-mark lp2-mark--absent lp2-w ${className}`}>{tok.v}</mark>;
    if (tok.t === "rival") return <mark key={i} className={`lp2-mark lp2-mark--rival lp2-w ${className}`}>{tok.v}</mark>;
    return <span key={i} className={`lp2-w ${className}`}>{tok.v}</span>;
  });
}
