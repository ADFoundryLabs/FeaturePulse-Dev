# FeaturePulse-Dev Remediation Directive (verified against `main` HEAD)

**Repo:** https://github.com/ADFoundryLabs/FeaturePulse-Dev
**Note:** An earlier audit of this repo contained several claims that no longer match the code (ESM config, webhook wiring, base64 decode, AI stub, DB pooling — all already fixed, comments in-code even mark them `// FIX 1/2/3`). This directive only includes issues confirmed present in the current source. Re-verify file contents before patching — this may drift further as work lands.

---

## Ground rules

- Verify each item against current source before editing; don't assume the description below is still accurate after other changes land.
- Build after each phase (`npm run build` in root, `next build` in `dashboard/`) and report pass/fail.
- Don't add dependencies without pinning a real version.

---

## Phase 1 — Immediate fixes (small, independent, do first)

1. **Port collision** — `src/index.ts:12` (`process.env.PORT || 3000`) collides with Next.js dashboard's default `3000`. Set backend default to `3001` (env override still wins), document both in `.env.example`/README.

2. **Silent installation_id on log insert** — `src/index.ts` lines ~113–117: the `analysis_logs` insert uses `(SELECT id FROM installations WHERE github_installation_id=$1)` inline as a value. If that installation row isn't found, this silently inserts `NULL` rather than failing. Fetch the installation row first, and if missing, log an error and skip the insert (or fail loud) instead of writing a row with a null FK.

3. **No timeout on OpenRouter call** — `src/services/ai.ts:41`, the `fetch()` to OpenRouter has no timeout. Add an `AbortController`-based timeout (e.g. 20–30s) so a hung provider doesn't leak the request forever with no result ever posted for that PR; on timeout, fall through to the existing safe-fallback return.

4. **Missing-intent-file is silent** — `src/index.ts:57-60`: currently just `console.log` + `return` when no `intent.md`/`.featurepulse/intent.md` is found. The PR author gets zero signal. Decide product behavior and implement:
   - (a) post a lightweight PR comment / neutral check run ("no intent.md found, skipped") so it's visible, or
   - (b) treat as a hard requirement and block.
     Either way, this event needs to be observable (see Phase 3 telemetry — this is also where `used_intent_file: false` should get logged).

**Phase 1 exit criteria:** build passes; both servers can run concurrently on distinct ports; a PR event with no intent file produces a visible outcome instead of silence; a PR event where the installation lookup fails doesn't write a null-FK row.

---

## Phase 2 — Resiliency & reliability

1. **Secret scrubbing** — `src/services/ai.ts`, before the diff is put into the prompt: add a regex-based scrubber for AWS keys, generic API tokens/bearer strings, and password-looking assignments. Apply to `diff` before it's interpolated into `prompt`.

2. **429 / rate-limit handling** — wrap both the OpenRouter `fetch()` in `ai.ts` and the Octokit calls in `github.ts` (`getContent`, `pulls.get`, `issues.createComment`, `checks.create`) with exponential backoff retry on 429/5xx. Octokit has built-in throttling plugins (`@octokit/plugin-throttling`) — prefer that over hand-rolled retry if adding a dependency is acceptable.

3. **`intent.md` caching** — `fetchIntentFile` in `github.ts` hits `getContent` on every `pull_request.opened`/`synchronize` event for the same repo. Add an in-memory (or Redis, if Phase 4 queue is added) cache keyed by `owner/repo` + ref, short TTL, to cut redundant calls and rate-limit burn.

4. **Diff truncation** — `ai.ts:25` truncates to `diff.substring(0, 5000)` and always appends "(truncated if too long)" even when it wasn't. Fix the cosmetic bug (only append when actually truncated) and consider whether 5000 chars is enough signal for larger PRs — flag this as a known limitation if not fixing chunking now.

**Phase 2 exit criteria:** simulate a 429 from OpenRouter and from GitHub — confirm retry/backoff instead of crash or silent drop; confirm `intent.md` isn't refetched on back-to-back events for the same repo within the cache TTL.

---

## Phase 3 — Telemetry

Extend `src/db/schema.sql` `analysis_logs` table with:

- `human_override BOOLEAN` — did a maintainer override/dismiss the AI's verdict
- `time_to_merge INTERVAL` — velocity impact
- `used_intent_file BOOLEAN` — distinguishes intent-driven runs from skipped ones (ties directly into Phase 1 item 4)

Wire these into the existing insert in `src/index.ts` and wherever override/merge events are observable (may need a new webhook subscription, e.g. `pull_request.closed` with `merged: true`, and a way to detect override — check current product scope before assuming a UI exists for this).

---

## Phase 4 — Architectural decoupling (only if scale requires it)

Current handler does diff-fetch → AI call → check-run → comment → DB insert inline inside the `webhooks.on(...)` listener, _after_ the HTTP response is already returned (fire-and-forget, not blocking the GitHub ack). This means the literal "10-second webhook timeout" failure mode doesn't apply today, but there's a real gap: no queue means no retry/persistence if the process crashes mid-analysis, and no natural back-pressure under high concurrent PR volume.

If/when volume justifies it: add BullMQ + Redis, move the fetch→analyze→comment chain into a worker, keep the webhook route as ack-only (it already basically is). Treat this as a scaling investment, not a correctness fix — don't do this before Phases 1–3.

---

## Reporting format expected back from the agent

Per phase: files changed, one-line summary per fix, exit-criteria result (pass/fail + how verified). Report what was actually done, not the plan restated.
