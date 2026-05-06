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
 * Decide whether a request should bypass cache lookup.
 *
 * Returns { skip: true, reason } if cache must be bypassed; { skip: false }
 * otherwise.
 *
 * Reasons:
 *   - maxAge=0: caller explicitly requested no-cache
 *   - profile: caller supplied browsing profile (logged-in state, custom
 *     cookies via Camoufox, etc.) — response is profile-specific, sharing
 *     it across tenants risks leaking authenticated content
 *   - auth-headers: Authorization or Cookie header present
 *   - custom-headers: any other caller-supplied header (Accept-Language,
 *     Referer, User-Agent override, etc.) materially affects downstream
 *     engines — mirrors the upstream index engine's eligibility check at
 *     engines/index/index.ts:55-58
 *   - sensitive-param:<name>: URL has token-like query param
 *   - invalid-url: URL doesn't parse
 *
 * For write-side eligibility (storeInCache, actions, location) see
 * `shouldSkipWriteback` which adds those checks on top of this predicate.
 */
export function shouldSkipCache(meta: Meta): {
  skip: boolean;
  reason?: string;
} {
  if (meta.options.maxAge === 0) {
    return { skip: true, reason: "maxAge=0" };
  }

  if (meta.options.profile !== undefined) {
    return { skip: true, reason: "profile" };
  }

  const headers = meta.options.headers ?? {};
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "cookie") {
      return { skip: true, reason: "auth-headers" };
    }
  }
  if (Object.keys(headers).length > 0) {
    return { skip: true, reason: "custom-headers" };
  }

  let parsed: URL;
  try {
    parsed = new URL(meta.rewrittenUrl ?? meta.url);
  } catch {
    return { skip: true, reason: "invalid-url" };
  }

  for (const [k] of parsed.searchParams.entries()) {
    if (SENSITIVE_QUERY_PARAMS.has(k.toLowerCase())) {
      return { skip: true, reason: `sensitive-param:${k}` };
    }
  }

  return { skip: false };
}
