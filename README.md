# pi-minimax-gs

Pi package with the native-review workarounds for the MiniMax model family. It ships three `tool_call`
extensions: one repairs a `gentle_review` START whose arguments arrived mangled, one blocks a
`gentle_review_capture` call that carries a capture binding that was rewritten, mangled or
re-serialized, and one re-serializes a `gentle_review` `input` that arrived as a JSON object where
the controller requires a JSON string. All three are local workarounds for provider-side argument
serialization, not a fix for the upstream tooling: delete them once the upstream defects land.

The general harness guards (reviewed-brief gate, destructive-command blocker, delivery gate,
reply-length reminder) live in [pi-warden-gs](https://github.com/sdiazbarraza/pi-warden-gs); this
package exists so that the MiniMax workarounds can be installed, audited and removed on their own.

## What it loads

`package.json` -> `pi.extensions` decides what loads; a file's presence in `extensions/` loads
nothing on its own.

| Extension | Hook | Behavior | Failure mode |
| --- | --- | --- | --- |
| `gentle-review-start-repair.ts` | `tool_call` | Repairs a `gentle_review` START whose `lenses`, `lensesReason` or `committedOnly` arrived mangled — including a lens list re-typed as `{"item": [...]}` — and restores the top-level envelope when the parameters were relocated inside `input` | Fail-open: any internal error passes the call through unchanged |
| `gentle-review-capture-guard.ts` | `tool_call` | Repairs a `gentle_review_capture` or `gentle_review_capture_group` binding whose scalar was retyped when its own token proves the original (`token === "--" + name + "=" + String(value)`), and restores an `arguments` field that arrived re-typed as `{"item": [...]}` to the array the provider issues; it blocks the rewrite it cannot prove, a mangled string, or a non-string non-object, naming the exact path | Fail-open on any internal error; writes `event.input` only to restore a proven value or a proven shape |
| `gentle-review-controller-input-repair.ts` | `tool_call` | Re-serializes a `gentle_review` `input` that arrived as a JSON object into the JSON string the controller requires, for every operation except START and ASSESS, and only when that object is provably lossless (the controller's own `serializeReviewJsonArgument` checks); a re-typed `committedOnly` becomes the boolean true in the re-serialized payload | Fail-open: any internal error passes the call through unchanged and stays silent |

A `tool_call` handler runs before the tool and may mutate `event.input`; Pi performs no validation
after that, which is why the START repair and the controller-input repair can rewrite the input and
the capture guard can only observe and block.

## Why these exist

An orchestrator that serializes tool arguments badly makes the native review fail in ways that never
name the cause:

- `input.lenses` arriving as a comma string, a duplicated array or non-canonical names, or a
  `lensesReason` with a newline or more than 500 bytes, is rejected as
  `native-start-input-invalid` / `lenses-invalid` / `lineage_created: false`.
- `input.lenses` arriving as the re-typed `{"item": [...]}` wrapper — the shape MiniMax emits — is
  the same class, but the declared list is inside the wrapper, so restoring it exactly is possible:
  the START repair uses the lenses inside instead of widening to all four, and widens only when the
  wrapper carries no usable name or a second key, which is not the shape the provider re-types.
- The boolean `input.committedOnly` arriving as `"true"` fails a committed-range START with
  `committed-only-required`.
- The whole tool envelope arriving with its top-level keys nested inside `input` is rejected as
  `operation: must have required properties operation`.
- A capture binding that was retyped (`0` or `true` where the provider issued `"0"` or `"true"`,
  usually in the nested `arguments[i].value`) is rejected downstream as `capture-binding-rejected` /
  "missing or stale for current STATUS", after the call was already spent. The guard repairs it when
  the binding proves the original — each `arguments` entry carries its own token — and blocks the
  rewrite it cannot prove. The object form of a binding is not a defect: the tool schema takes an
  object or the issued string.
- A capture binding whose `arguments` array arrived as `{"item": [...]}` carries a shape the
  provider never issues, so it is rejected downstream like any other mismatch. The guard restores
  the array in place — the entries are the ones the provider issued — and lets them go through the
  same scalar repair. Any other shape of `arguments` is left exactly as it is.
- A `gentle_review` `input` that arrives as a JSON object is rejected as "Review controller input
  must be a string" on every operation except START and ASSESS, so the lineage stalls on `status`,
  `answer-consent` and `acknowledge-approved` without the rejection ever naming the cause.
- A `gentle_review` `input` payload whose `committedOnly` arrived as `"true"` or `1` carries a value
  the controller only accepts as the boolean true, so the re-serialized payload normalizes it;
  every other value, the boolean true included, stays as it is.

The START repair fixes the first three classes before the tool runs. The capture guard repairs only
what the binding itself proves — a token-confirmed scalar, and the `arguments` array the provider
issues — and names the cause of every other rewrite, asking for a verbatim re-copy, which is the
only correct repair. The controller-input repair fixes the last two classes by re-serializing the
object into the string the controller reads and normalizing the re-typed `committedOnly` inside it,
but only when the payload is provably lossless: a payload the controller would reject is left
untouched, so it keeps rejecting it and still names the cause.

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
ships these three extensions. `pi-warden-gs` 1.x still contains the first two files, and registering
both packages would register each `tool_call` handler twice, so upgrade that package before enabling
this one.

## Verify

```bash
node --experimental-strip-types --test tests/*.test.ts
```

All 43 tests pass on a clean machine. They cover the START repair (9 cases: the mangled lens
shapes, including a list re-typed as `{"item": [...]}`, the `committedOnly` shapes, the relocated
envelope, and the calls it must leave alone), the
capture guard (22 cases: the provable repair of a nested retyped scalar in the object and the
serialized form, the restore of an `arguments` array that arrived as `{"item": [...]}` in the object
and in the serialized form, the scalar repair of a restored entry, the block of an unconfirmable
value at the array path, the untouched shapes of `arguments`, the fields the contract issues as
numbers, the contract numbers of a correction-plan binding, the group index naming, the
byte-identical pass-through of a valid issued string and of an all-string object, the fail-open path
and the debug output) and the controller-input repair (12 cases: the re-serialization of an object
`input` for every operation that requires a JSON string, the normalization of a re-typed
`committedOnly`, the calls it must leave alone, the lossy payloads the controller would reject, the
fail-open path, the debug output and the block of another extension in the same chain). Node's
TypeScript stripping is experimental, so the flag is required on Node 22.

Set `GENTLE_AI_DEBUG_LENS_PATCH=1` for one stderr line per executed START repair,
`GENTLE_AI_DEBUG_BINDING_GUARD=1` for one stderr line per repaired or blocked capture call, and
`GENTLE_AI_DEBUG_CONTROLLER_INPUT=1` for one stderr line per re-serialized controller input.

## Uninstall

Remove the package path from the `packages` list of `settings.json` (or run the matching
`pi uninstall`) and `/reload`, or delete this directory.

## License

MIT.
