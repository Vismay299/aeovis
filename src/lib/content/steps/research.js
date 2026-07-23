import { renderStepPrompt } from "../skills/loader.js";
import { validateResearchPack } from "../schemas.js";
import { scrapeForSummary } from "../../firecrawl.js";
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
  const scrape = deps.scrape || scrapeForSummary;

  const targetQueries =
    ctx.workOrder?.target_queries?.length > 0
      ? ctx.workOrder.target_queries
      : [ctx.input?.query].filter(Boolean);

  const rows = rowsForQueries(ctx.scan, targetQueries);

  // Scrape the top winning cited pages (2–3). For linkedin, topic scans may
  // have no rows — that's fine, the pack leans on the model + brief instead.
  const winnerUrls = topCitedUrls(rows, 3);
  const scraped = [];
  for (const url of winnerUrls) {
    try {
      const content = await scrape(url);
      if (content && content !== "No website content available.") {
        scraped.push({ url, content });
      }
    } catch (err) {
      console.warn(`[research] scrape failed for ${url}:`, err.message);
    }
  }
  ctx.scrapedPages = scraped;

  const scanAnswersBlock =
    rows.length > 0
      ? formatScanAnswers(rows)
      : ctx.input?.answer_text
        ? `### [${ctx.input.engine || "aio"}] "${ctx.input.query}"\n${String(ctx.input.answer_text).slice(0, 1400)}`
        : "(no scan answers available — compensate with scraped sources and general knowledge, and flag weakly-supported areas)";

  const prompt = renderStepPrompt("research", ctx.playbook, {
    brand: ctx.brand,
    brief: ctx.brief,
    agent: formatAgentOverlay(ctx.agent),
    lessons: formatLessons(ctx.lessons),
    work_order: ctx.workOrder,
    scan_answers: scanAnswersBlock,
    scraped_pages: formatScrapedPages(scraped),
  });

  return callStepLlm({
    step: "research",
    prompt,
    validate: validateResearchPack,
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.3,
  });
}
