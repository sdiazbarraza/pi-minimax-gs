# pi-minimax-gs

Pi package with the native-review workarounds for the MiniMax model family. It ships two `tool_call`
extensions: one repairs a `gentle_review` START whose arguments arrived mangled, and one blocks a
`gentle_review_capture` call that carries a capture binding that was rewritten, mangled or
re-serialized. Both are local workarounds for provider-side argument serialization, not a fix for the
upstream tooling: delete them once the upstream defects land.

The general harness guards (reviewed-brief gate, destructive-command blocker, delivery gate,
reply-length reminder) live in [pi-warden-gs](https://github.com/sdiazbarraza/pi-warden-gs); this
package exists so that the MiniMax workarounds can be installed, audited and removed on their own.

## What it loads

`package.json` -> `pi.extensions` decides what loads; a file's presence in `extensions/` loads
nothing on its own.

| Extension | Hook | Behavior | Failure mode |
| --- | --- | --- | --- |
| `gentle-review-start-repair.ts` | `tool_call` | Repairs a `gentle_review` START whose `lenses`, `lensesReason` or `committedOnly` arrived mangled, and restores the top-level envelope when the parameters were relocated inside `input` | Fail-open: any internal error passes the call through unchanged |
| `gentle-review-capture-guard.ts` | `tool_call` | Blocks a `gentle_review_capture` or `gentle_review_capture_group` call whose binding was rewritten, naming one of four causes; the object form of a binding is legitimate and passes through | Fail-open on any internal error; never writes `event.input` |

A `tool_call` handler runs before the tool and may mutate `event.input`; Pi performs no validation
after that, which is why the START repair can rewrite the input and the capture guard can only
observe and block.

## Why these exist

An orchestrator that serializes tool arguments badly makes the native review fail in ways that never
name the cause:

- `input.lenses` arriving as a comma string, a duplicated array or non-canonical names, or a
  `lensesReason` with a newline or more than 500 bytes, is rejected as
  `native-start-input-invalid` / `lenses-invalid` / `lineage_created: false`.
- The boolean `input.committedOnly` arriving as `"true"` fails a committed-range START with
  `committed-only-required`.
- The whole tool envelope arriving with its top-level keys nested inside `input` is rejected as
  `operation: must have required properties operation`.
- A capture binding that was retyped (`1` instead of `"1"`) or mangled (one stray closing brace) is
  rejected downstream, after the call was already spent. The object form is not a defect: the tool
  schema takes an object or the issued string, and the controller accepts both.

The START repair fixes the first three classes before the tool runs. The capture guard cannot repair
a binding — it has no canonical form and its digest rejects any change — so it names the cause and
asks for a verbatim re-copy, which is the only correct repair.

## Install

```bash
pi install /absolute/path/to/pi-minimax-gs     # registers the package for Pi
```

Or add the directory to the `packages` list of your Pi `settings.json`:

```json
{ "packages": ["/absolute/path/to/pi-minimax-gs"] }
```

Run `/reload` in a session that is already open; a new session loads the package on its own. Do not
copy the files into `<agent-dir>/extensions/` as well: the handler would register twice.

**Compatibility:** install this package next to `pi-warden-gs` **2.0.0 or newer**, which no longer
ships these two extensions. `pi-warden-gs` 1.x still contains both files, and registering both
packages would register each `tool_call` handler twice, so upgrade that package before enabling this
one.

## Verify

```bash
node --experimental-strip-types --test tests/*.test.ts
```

All 21 tests pass on a clean machine. They cover the START repair (8 cases: the mangled lens shapes,
the `committedOnly` shapes, the relocated envelope, and the calls it must leave alone) and the capture
guard (12 cases: the four blocking causes, the group index naming, the byte-identical pass-through of
a valid issued string and of an all-string object, the fail-open path and the debug output). Node's
TypeScript stripping is
experimental, so the flag is required on Node 22.

Set `GENTLE_AI_DEBUG_LENS_PATCH=1` for one stderr line per executed START repair, and
`GENTLE_AI_DEBUG_BINDING_GUARD=1` for one stderr line per blocked capture call.

## Uninstall

Remove the package path from the `packages` list of `settings.json` (or run the matching
`pi uninstall`) and `/reload`, or delete this directory.

## License

MIT.
