# gentle-review-start-repair — usage note

Local Pi extension working around `Gentleman-Programming/gentle-shell` issue #2280: an
orchestrator whose tool-argument serialization mangles `input.lenses` (a string instead of an
array, duplicate or non-canonical names) or sends a `lensesReason` with a newline or more than 500
bytes makes `gentle_review {"operation":"start"}` fail with
`native-start-input-invalid` / `reason: "lenses-invalid"` / `lineage_created: false`, even though
the orchestrator did select lenses. The same family of mangling turns the boolean
`input.committedOnly` into `"true"`, which fails a committed-range START with
`committed-only-required`. The handler repairs those fields in place, before the tool runs, and
leaves every other field and every non-`start` operation untouched: `true`/`"true"`/`1`/`"1"`
become the boolean `true`, and `false`/`"false"`/`0`/`"0"` drop the key (equivalent to the
provider's own default, since the contract rejects a standalone false).

**Enable it:** the file ships inside the `pi-minimax-gs` package and is registered in its
`package.json` (`pi.extensions`), so Pi loads `extensions/gentle-review-start-repair.ts` from this package at startup and `/reload` activates it in a session that is already open. Nothing else is needed: no
orchestrator-side change and no copy under `<agent-dir>/extensions/` (the directories named in the
original task prompt, `~/.pi/extensions/` and `~/.gentle-shell/agent/extensions/`, do not exist and
are not loaded). If Pi ever reports no repair for a mangled START, check that the file is still
listed in `package.json` — that list, not the file's presence, decides what loads. To confirm it is working, run a session with
`GENTLE_AI_DEBUG_LENS_PATCH=1`; every repair prints
`[gentle-review-start-repair] repaired START input: lenses=[...] reasonBytes=N` on stderr. Delete the
file once the upstream fix for #2280 lands.

Known limitation, deliberately out of scope: when a lens value is present but unusable (for example
`"banana"`), the fallback fills all four lenses, so that call asks the provider for the full
four-lens review.
