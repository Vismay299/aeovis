import {makeSourceSnapshot} from '../../repairs/workflow.js';
import {researchEvidence} from '../../repairs/researchContract.js';
import { renderStepPrompt } from "../skills/loader.js";
import { validateResearchPack } from "../schemas.js";
import { normalizeScrapeResult, scrapeSite } from "../../firecrawl.js";
import {
  callStepLlm,
  formatLessons,
  formatAgentOverlay,
  rowsForQueries,
  formatScanAnswers,
  topCitedUrls,
  formatScrapedPages,
} from "./shared.js";

/**
 * Research step: build the grounded research pack.
 * geo_article: verbatim AI answers + citations for the target queries from
 * the latest scan, plus Firecrawl-scraped top winning cited pages.
 * linkedin_post: same sources filtered through the brand profile.
 *
 * Side effect: ctx.scrapedPages is populated so the benchmark step reuses
 * the same scrapes instead of paying for them twice.
 */
export async function runResearch(ctx, deps = {}) {
  const scrape = deps.scrape || scrapeSite;

  const targetQueries =
    ctx.workOrder?.target_queries?.length > 0
      ? ctx.workOrder.target_queries
      : [ctx.input?.query].filter(Boolean);

  const rows = rowsForQueries(ctx.scan, targetQueries);

  // Scrape the top winning cited pages (2–3). For linkedin, topic scans may
  // have no rows — that's fine, the pack leans on the model + brief instead.
  const winnerUrls = topCitedUrls(rows, 3);
  const scraped = [];
  const skippedScrapes = [];
  for (const url of winnerUrls) {
    try {
      // R3.7.2: this used to compare the returned string against the literal
      // "No website content available." — the sentinel was the API. Now the
      // scrape reports its own state and the reason is kept, not inferred.
      const res = normalizeScrapeResult(await scrape(url));
      if (res.content) {
        scraped.push({ url, content: res.content, snapshot:makeSourceSnapshot({url,text:res.content}) });
      } else {
        skippedScrapes.push(`${url} (${res.state_reason})`);
      }
    } catch (err) {
      skippedScrapes.push(`${url} (threw: ${err.message})`);
      console.warn(`[research] scrape failed for ${url}:`, err.message);
    }
  }
  ctx.scrapedPages = scraped;
  // A research pack built on 0 of 3 winning pages is not the same artifact as
  // one built on 3 of 3. There is no persisted channel on ctx for this today,
  // so the log line is the trace — but it names the count AND the reason,
  // rather than the step continuing as if it had scraped everything.
  if (skippedScrapes.length > 0) {
    console.warn(
      `[research] ${skippedScrapes.length}/${winnerUrls.length} winning pages could not be ` +
        `scraped, so the research pack is thinner than it looks: ${skippedScrapes.join(", ")}`
    );
  }

  const scanAnswersBlock =
    rows.length > 0
      ? formatScanAnswers(rows)
      : ctx.input?.answer_text
        ? `### [${ctx.input.engine || "aio"}] "${ctx.input.query}"\n${String(ctx.input.answer_text).slice(0, 1400)}`
        : "(no captured scan answers; do not invent sources or client facts; keep unsupported claims unresolved)";

  const prompt = renderStepPrompt("research", ctx.playbook, {
    brand: ctx.input?.brand_name || ctx.brand,
    brief: ctx.brief,
    agent: formatAgentOverlay(ctx.agent),
    lessons: formatLessons(ctx.lessons),
    knowledge: ctx.knowledge || "(no knowledge blocks configured)",
    work_order: ctx.workOrder,
    scan_answers: scanAnswersBlock,
    scraped_pages: formatScrapedPages(scraped),
  });

  const pack = await callStepLlm({
    step: "research",
    prompt,
    validate: validateResearchPack,
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.3,
  });
  return {...pack,evidence:researchEvidence({snapshots:scraped.map(p=>p.snapshot),skipped:skippedScrapes,
    clientFacts:ctx.input?.approved_facts || []})};
}
