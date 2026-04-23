import { InternalOptions } from "../scraper/scrapeURL";
import {
  Document,
  ScrapeOptions,
  TeamFlags,
  shouldParsePDF,
} from "../controllers/v2/types";
import { CostTracking } from "./cost-tracking";
import { hasFormatOfType } from "./format-utils";
import { TransportableError } from "./error";
import { FeatureFlag } from "../scraper/scrapeURL/engines";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { config } from "../config";

// Upstream Firecrawl constants. Kept here so the fallback branch below (when
// ZAPFETCH_FLAT_PRICING=false) mirrors upstream exactly for drop-in revert.
const creditsPerPDFPage = 1;
const stealthProxyCostBonus = 4;
const unblockedDomainCostBonus = 4;

// [ZAPFETCH-OVERRIDE] pricing.md §一: "1 credit = 1 操作, 永远, 无格式乘数".
// ZAPFETCH_FLAT_PRICING=true (default) → successful scrape always bills 1 credit.
// ZAPFETCH_FLAT_PRICING=false → falls back to upstream multi-factor pricing.
// FIRE-1 agent (LLM-driven scraping, priced by token cost × 1800) and DNS
// failure 1-credit rule are shared behavior and apply under both modes.
// See firecrawl/ZAPFETCH-OVERRIDES.md.
export async function calculateCreditsToBeBilled(
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  document: Document | null,
  costTracking: CostTracking | ReturnType<typeof CostTracking.prototype.toJSON>,
  flags: TeamFlags,
  error?: Error | null,
  unsupportedFeatures?: Set<FeatureFlag>,
) {
  const costTrackingJSON: ReturnType<typeof CostTracking.prototype.toJSON> =
    costTracking instanceof CostTracking ? costTracking.toJSON() : costTracking;

  const isFire1 =
    internalOptions.v1Agent?.model?.toLowerCase() === "fire-1" ||
    internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1";

  if (document === null) {
    // Failure path. Shared between flat and upstream modes: FIRE-1 bills its
    // actual LLM cost even on failure; DNS resolution errors bill 1 credit.
    let creditsToBeBilled = 0;
    if (isFire1) {
      creditsToBeBilled = Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
    }
    if (
      error instanceof TransportableError &&
      error.code === "SCRAPE_DNS_RESOLUTION_ERROR"
    ) {
      creditsToBeBilled = 1;
    }
    return creditsToBeBilled;
  }

  if (isFire1) {
    return Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
  }

  if (config.ZAPFETCH_FLAT_PRICING) {
    return 1;
  }

  // --- upstream fallback: preserved verbatim for drop-in revert ---
  let creditsToBeBilled = 1;
  const changeTrackingFormat = hasFormatOfType(
    options.formats,
    "changeTracking",
  );
  if (
    hasFormatOfType(options.formats, "json") ||
    changeTrackingFormat?.modes?.includes("json")
  ) {
    creditsToBeBilled = 5;
  }
  if (hasFormatOfType(options.formats, "query")) {
    creditsToBeBilled += 4;
  }
  if (hasFormatOfType(options.formats, "audio")) {
    creditsToBeBilled += 4;
  }
  if (internalOptions.zeroDataRetention) {
    creditsToBeBilled += flags?.zdrCost ?? 1;
  }
  const shouldParse = shouldParsePDF(options.parsers);
  if (
    shouldParse &&
    document.metadata?.numPages !== undefined &&
    document.metadata.numPages > 1
  ) {
    creditsToBeBilled += creditsPerPDFPage * (document.metadata.numPages - 1);
  }
  if (
    document?.metadata?.proxyUsed === "stealth" &&
    !unsupportedFeatures?.has("stealthProxy")
  ) {
    creditsToBeBilled += stealthProxyCostBonus;
  }
  const urlsToCheck = [
    document.metadata?.url,
    document.metadata?.sourceURL,
  ].filter((u): u is string => !!u);
  if (urlsToCheck.some(u => isUrlBlocked(u, null) && !isUrlBlocked(u, flags))) {
    creditsToBeBilled += unblockedDomainCostBonus;
  }
  return creditsToBeBilled;
}
