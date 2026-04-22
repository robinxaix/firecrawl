import { RateLimiterRedis } from "rate-limiter-flexible";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import Redis from "ioredis";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";

export const redisRateLimitClient = new Redis(config.REDIS_RATE_LIMIT_URL!, {
  enableAutoPipelining: true,
});

const createRateLimiter = (keyPrefix, points) =>
  new RateLimiterRedis({
    storeClient: redisRateLimitClient,
    keyPrefix,
    points,
    duration: 60, // Duration in seconds
  });

const fallbackRateLimits: AuthCreditUsageChunk["rate_limits"] = {
  crawl: 15,
  scrape: 100,
  search: 100,
  map: 100,
  extract: 100,
  preview: 25,
  extractStatus: 25000,
  crawlStatus: 25000,
  extractAgentPreview: 10,
  scrapeAgentPreview: 10,
  browser: 2,
  browserExecute: 10,
  account: 1000,
};

export function getRateLimiter(
  mode: RateLimiterMode,
  rate_limits: AuthCreditUsageChunk["rate_limits"] | null,
): RateLimiterRedis {
  // [ZAPFETCH-OVERRIDE] pricing.md §二: Free=5 / Starter=50 / Pro=200 rpm for
  // scrape+search. Upstream Firecrawl previously forced rpm ≥ 100 via
  // Math.max(rateLimit, 100) (marked "TEMP: Mogery"), which nullified the
  // backend plans table's lower tiers. Removed unconditionally — no kill
  // switch because this is a read-only code path with low revert cost.
  // See firecrawl/ZAPFETCH-OVERRIDES.md.
  const rateLimit = rate_limits?.[mode] ?? fallbackRateLimits?.[mode] ?? 500;
  return createRateLimiter(`${mode}`, rateLimit);
}
