import { Meta } from "../..";

const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "signature",
  "sig",
  "auth",
  "apikey",
  "api_key",
  "access_token",
  "id_token",
  "session",
  "sessionid",
  "session_id",
]);

/**
 * Decide whether a request should bypass cache (both lookup and write).
 *
 * Returns { skip: true, reason } if cache must be bypassed; { skip: false }
 * otherwise.
 *
 * Reasons (DC7 from docs/response-cache-plan.md):
 *   - maxAge=0: caller explicitly requested no-cache
 *   - auth-headers: Authorization or Cookie header present
 *   - sensitive-param:<name>: URL has token-like query param
 *
 * Non-2xx and zeroDataRetention checks are applied at the WRITE side
 * (in the engine fallback chain after a fresh scrape), not here.
 */
export function shouldSkipCache(meta: Meta): {
  skip: boolean;
  reason?: string;
} {
  if (meta.options.maxAge === 0) {
    return { skip: true, reason: "maxAge=0" };
  }

  const headers = meta.options.headers ?? {};
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "cookie") {
      return { skip: true, reason: "auth-headers" };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(meta.rewrittenUrl ?? meta.url);
  } catch {
    // Bad URL won't cache — cleanest to skip (engine fallback will handle).
    return { skip: true, reason: "invalid-url" };
  }

  for (const [k] of parsed.searchParams.entries()) {
    if (SENSITIVE_QUERY_PARAMS.has(k.toLowerCase())) {
      return { skip: true, reason: `sensitive-param:${k}` };
    }
  }

  return { skip: false };
}
