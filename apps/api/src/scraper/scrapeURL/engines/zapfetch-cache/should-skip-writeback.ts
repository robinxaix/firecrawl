import { Meta } from "../..";
import { shouldSkipCache } from "./should-skip";

/**
 * Decide whether a freshly-scraped response should be written back to cache.
 *
 * Strict superset of `shouldSkipCache`:
 *   - All read-side skip reasons apply, EXCEPT `maxAge=0` — that's a
 *     caller-side "force fresh fetch for me" signal, not a directive that
 *     the cache shouldn't be populated for future readers. Without this
 *     carve-out, callers passing maxAge=0 silently disable writeback,
 *     which masked Phase-1 dormant deployments (codex challenge round 2).
 *
 * Plus three write-only checks:
 *   - storeInCache=false: caller opted out of cache writes
 *   - actions: click/scroll/wait sequences materially alter the response
 *     but aren't part of the cache key. Caching them would poison vanilla
 *     lookups for the same URL.
 *   - location: geo-pinned scrape — caching the row would mislead requests
 *     from other countries/languages.
 */
export function shouldSkipWriteback(meta: Meta): {
  skip: boolean;
  reason?: string;
} {
  const readSkip = shouldSkipCache(meta);
  if (readSkip.skip && readSkip.reason !== "maxAge=0") {
    return readSkip;
  }

  if (meta.options.storeInCache === false) {
    return { skip: true, reason: "storeInCache=false" };
  }

  const actions = meta.options.actions;
  if (Array.isArray(actions) && actions.length > 0) {
    return { skip: true, reason: "actions" };
  }

  const loc = meta.options.location;
  if (loc !== undefined && loc !== null) {
    const hasCountry =
      typeof loc.country === "string" && loc.country.length > 0;
    const hasLanguages =
      Array.isArray(loc.languages) && loc.languages.length > 0;
    if (hasCountry || hasLanguages) {
      return { skip: true, reason: "location" };
    }
  }

  return { skip: false };
}
