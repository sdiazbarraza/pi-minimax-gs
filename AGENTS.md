# AGENTS.md

Local Pi package with the workarounds the native review path needs on the MiniMax model family:
a START repair for `gentle_review`, a tripwire for `gentle_review_capture` bindings and a repair for
a `gentle_review` `input` that arrived as a JSON object where the controller requires a JSON string.

Pi loads this package from its own path (`~/.pi/agent/settings.json` lists `../../pi-minimax-gs`),
so an edit here reaches a live session only after `/reload`.

## Layout

- `extensions/*.ts` — one extension per file, `export default (pi: ExtensionAPI) => void`: one file
  per workaround (`gentle-review-start-repair.ts`, `gentle-review-capture-guard.ts`,
  `gentle-review-controller-input-repair.ts`).
- `tests/*.test.ts` — `node:test` suites, one file per extension.
- `README.md` — user-facing documentation; it states the total test count and the per-extension case count.

## Commands

```bash
node --experimental-strip-types --test tests/*.test.ts          # full suite
node --experimental-strip-types --test tests/capture-guard.test.ts  # one file
```

Node 22 requires the `--experimental-strip-types` flag. There is no build step and no dependency to
install: the suites import the extensions directly with a fake `ExtensionAPI`.

## Rules

- A behavior change is test-first: add the test, observe it fail for the stated reason, then implement.
- All three extensions fail open. An internal error must pass the call through unchanged and stay
  silent, so the controller reports its own rejection.
- Never widen a guard beyond a rule it can name. Every new exemption or repair carries its own test
  and the matching documentation line.
- Update the counts in `README.md` whenever a test is added or removed.
- Node built-ins only. No new dependency without an explicit decision.
- Conventional Commits. Do not commit or push unless asked.

## Briefs for delegated work

The worker guard accepts one order only, and every heading must be non-empty:
`## Objective`, `## Preconditions`, `## Steps`, `## Allowed edit surfaces`, `## Verification`,
`## Acceptance criteria`, `## Architecture constraints`, `## Report`.

A behavior change carries `Strict TDD is active.` as the first line of `## Steps`, with a RED step
before any implementation.
