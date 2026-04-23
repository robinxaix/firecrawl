# ZapFetch Overrides

> This is a **ZapFetch fork** of [mendableai/firecrawl](https://github.com/mendableai/firecrawl).
> Most code here is upstream verbatim. This file is the single source of truth for
> every intentional divergence from upstream.
>
> **Grep for `ZAPFETCH-OVERRIDE` in the codebase to find all marker comments.**

---

## Maintenance protocol

### Before each `git merge upstream/main`

1. `git grep "ZAPFETCH-OVERRIDE"` — confirm the list below matches what's in tree.
2. Skim the upstream diff for files listed in the table. If upstream changed
   the same block you overrode, expect a merge conflict and resolve by
   preserving the ZAPFETCH-OVERRIDE branch while picking up any upstream
   improvements around it.
3. If upstream's behavior genuinely supersedes your override (e.g. they added
   the same kill-switch you added), remove the override and update this file.

### Conventions

- Every override has a `[ZAPFETCH-OVERRIDE]` marker in the file, with a one-line
  reason and a reference to `docs/price/pricing.md` or the relevant decision doc.
- High-revert-risk overrides (anything touching billing, auth, rate limits)
  must expose an env kill-switch so we can roll back without shipping a code
  change. Low-risk overrides (read-only, small diff) can skip the switch.
- Upstream code that was overridden should be preserved verbatim inside the
  fallback branch (where possible) so the diff against upstream stays small.

---

## Active overrides

| File | Lines | Kill-switch | Reason | Reference |
|------|-------|-------------|--------|-----------|
| `apps/api/src/lib/scrape-billing.ts` | ~18–110 | `ZAPFETCH_FLAT_PRICING` (default `true`) | Flat 1-credit per successful scrape, regardless of format / proxy / PDF pages / ZDR. Upstream charges 5 for json, +4 for query/audio/stealth/unblocked, +1 per extra PDF page, +zdrCost for ZDR. | `docs/price/pricing.md` §一、§八 FAQ |
| `apps/api/src/services/rate-limiter.ts` | ~35–48 | — (low-risk, no switch) | Remove `Math.max(rateLimit, 100)` scrape/search floor (upstream "TEMP: Mogery"). Let backend plans table dictate Free=5 / Starter=50 / Pro=200 rpm. | `docs/price/pricing.md` §二 |
| `apps/api/src/config.ts` | (billing section) | n/a (this file defines the switch) | Adds `ZAPFETCH_FLAT_PRICING` env var to zod schema. | — |
| `apps/api/src/**/*.ts` (user-visible URLs) | batch sed | — | Every occurrence of `https://firecrawl.dev/pricing` rewritten to `https://console.zapfetch.com/#pricing`. Covers rate-limit / insufficient-credits error messages, `upgrade_url` JSON fields, and email notification HTML. Anchor text in email templates that previously displayed "firecrawl.dev/pricing" is also rewritten to "console.zapfetch.com/#pricing" so the visible link label matches the href. | `docs/price/pricing.md` (landing URL) |

### Maintaining the URL sweep across upstream merges

This override is a batch substitution across all `apps/api/src/**/*.ts`,
not a single-point marker. After each upstream merge, re-apply:

```bash
# href / bare URL references
grep -rl "firecrawl\.dev/pricing" apps/api/src/ --include="*.ts" | while read f; do
  sed -i '' 's|https://firecrawl\.dev/pricing|https://console.zapfetch.com/#pricing|g' "$f"
done

# anchor text that still reads "firecrawl.dev/pricing"
sed -i '' "s|>firecrawl.dev/pricing</a>|>console.zapfetch.com/#pricing</a>|g" \
  apps/api/src/services/notification/email_notification.ts
```

Verify zero remaining references: `git grep "firecrawl.dev/pricing" apps/api/src/`.

Other brand / support references (`help@firecrawl.com`, "Firecrawl Team"
sign-offs, `firecrawl.dev/app/account-settings`) are intentionally left
alone — not pricing-alignment concerns, and tracking them here would
bloat the override surface without user impact.

---

## Override design patterns

### Pattern 1: kill-switch with preserved upstream fallback

For high-risk code paths (billing, auth, rate limits):

```ts
// [ZAPFETCH-OVERRIDE] <why>. See ZAPFETCH-OVERRIDES.md.
if (config.ZAPFETCH_<FEATURE_FLAG>) {
  return <zapfetch behavior>;
}
// --- upstream fallback: preserved verbatim for drop-in revert ---
<original upstream logic unchanged>
```

Benefits:
- Rollback is an env-var flip, no code change or redeploy-from-source
- `git diff upstream/main` on the fallback block stays empty → low merge conflict risk
- Post-upgrade A/B testing is trivial (flip flag in staging, compare)

### Pattern 2: hard override (low-risk)

For small reads / no revert need:

```ts
// [ZAPFETCH-OVERRIDE] <why>. See ZAPFETCH-OVERRIDES.md.
<zapfetch code>
// (upstream code removed; recover via git history if needed)
```

Use this when: the change is 1–5 lines, has no runtime-controllable behavior,
and "revert" = redeploy a previous image.

### Pattern 3: new files

If an override grows beyond ~50 LOC, extract to a new file under
`apps/api/src/zapfetch/` so the upstream file only contains a one-line import
and call. This keeps upstream-file diffs tiny and merge conflicts rare.
(Not used today; document future additions here.)

---

## Upstream sync workflow

```bash
# One-time setup
git remote add upstream https://github.com/mendableai/firecrawl.git
git fetch upstream

# Monthly sync cadence
git checkout main                       # our upstream-mirror branch
git fetch upstream
git merge --ff-only upstream/main       # fast-forward only; must stay clean
git push origin main

git checkout zapfetch/main              # our production branch
git merge main                          # merge upstream into production
# resolve any conflicts — ZAPFETCH-OVERRIDE markers make them easy to spot
git push origin zapfetch/main
```

If `--ff-only` on `main` fails, something non-upstream landed on `main` — fix it
first (move that commit to `zapfetch/main` and hard-reset `main` to upstream).

---

## Change log

- **2026-04-22** — Initial version. Added `scrape-billing.ts` flat-pricing
  override (with kill-switch) and `rate-limiter.ts` rpm-floor removal.
  See `docs/price/pricing-alignment-2026-04-22.md`.
