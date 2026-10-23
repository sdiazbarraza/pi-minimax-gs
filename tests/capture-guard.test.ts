import { test } from "node:test"
import assert from "node:assert/strict"
import register from "../extensions/gentle-review-capture-guard.ts"

// Deterministic coverage for the capture-binding tripwire. The extension is loaded through its
// default export with a fake ExtensionAPI and its registered `tool_call` handler is driven with
// synthetic events: no model, no provider and no review authority involved. A provider-issued
// collect binding is opaque and digest-checked, so the guard repairs a retyped value only when the
// binding itself proves the original — each `arguments` entry carries its own token and
// `token === "--" + name + "=" + String(value)` — and blocks the rewrite it cannot prove.
const LINEAGE = `lin_${"0".repeat(32)}`

type Handler = (event: unknown) => unknown
function handler(): Handler {
  const registrations: Array<{ name: string; handler: Handler }> = []
  register({ on: (name: string, h: Handler) => (registrations.push({ name, handler: h }), () => {}) } as never)
  const found = registrations.find((entry) => entry.name === "tool_call")
  assert.ok(found, "extension did not register a tool_call handler")
  return found.handler
}

/** A provider-shaped collect input: every top-level scalar is a string. */
const providerBinding = (): Record<string, unknown> => ({
  name: "reviewer_result",
  schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
  captureOperation: "review.capture-result",
  baseTree: "b".repeat(40),
})

/** A binding with the shape the provider actually issues: arguments, an artifact subject and a
 * submission, where `selectedOrder` and `substitutionLocation` are numbers by contract. */
const issuedBinding = () => ({
  arguments: [
    { name: "lineage", token: "--lineage=review-1", value: "review-1" },
    { name: "order", token: "--order=0", value: "0" },
    { name: "materialize", token: "--materialize=true", value: "true" },
  ],
  artifactSubject: { lineageId: "review-1", lens: "review-reliability", selectedOrder: 0 },
  baseTree: "b".repeat(40),
  candidateTree: "c".repeat(40),
  captureOperation: "review.capture-result",
  name: "reviewer_result",
  schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
  submission: {
    argumentTokens: ["--lineage=review-1"],
    operationToken: "capture-result",
    values: [{ domain: "artifact_path_or_stdin", slot: "reviewer_result", substitutionLocation: 8 }],
  },
})

const captureCall = (toolName: string, binding: unknown) => ({
  toolName,
  input: { lineageId: LINEAGE, collectBinding: binding },
})

const groupCall = (toolName: string, bindings: readonly unknown[]) => ({
  toolName,
  input: { lineageId: LINEAGE, collectBindings: bindings },
})

type Write = typeof process.stderr.write
async function captureStderr(run: () => unknown): Promise<string[]> {
  const original = process.stderr.write
  const lines: string[] = []
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as unknown as Write
  try {
    await run()
  } finally {
    process.stderr.write = original
  }
  return lines
}

test("blocks a capture binding retyped to a number, naming key and value", async () => {
  const run = handler()
  const event = captureCall("gentle_review_capture", { ...providerBinding(), value: 1 })
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected the retyped binding to be blocked")
  assert.match(result?.reason ?? "", /gentle_review_capture/)
  assert.match(result?.reason ?? "", /collectBinding\b/)
  assert.match(result?.reason ?? "", /"value"/, "reason must name the offending key")
  assert.match(result?.reason ?? "", /\bnumber 1\b/, "reason must name the offending value")
  assert.match(result?.reason ?? "", /verbatim/i, "reason must ask for a verbatim re-copy")
  assert.deepEqual(event, before, "the guard must never change the call")
})

test("blocks the retyped binding of a group capture at its own index", async () => {
  const run = handler()
  const event = groupCall("gentle_review_capture_group", [JSON.stringify(providerBinding()), { ...providerBinding(), value: true }])
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected the retyped group binding to be blocked")
  assert.match(result?.reason ?? "", /gentle_review_capture_group/)
  assert.match(result?.reason ?? "", /collectBindings\[1\]/)
  assert.match(result?.reason ?? "", /"value"/, "reason must name the offending key")
  assert.match(result?.reason ?? "", /\bboolean true\b/, "reason must name the offending value")
  assert.match(result?.reason ?? "", /verbatim/i)
  assert.deepEqual(event, before, "the guard must never change the call")
})

// A binding may arrive as an object or as the exact issued string: the tool schema allows both and
// the controller accepts both, so the guard must leave the object form alone. It blocked that form
// once, on a rejected batch whose real cause was a stale group, and the block cost several retries.
test("passes an all-string object binding through byte-identical", async () => {
  const run = handler()
  const cases = [
    captureCall("gentle_review_capture", providerBinding()),
    groupCall("gentle_review_capture_group", [providerBinding(), { ...providerBinding(), baseTree: "c".repeat(40) }]),
    captureCall("gentle_review_capture", { ...providerBinding(), arguments: [{ name: "order", value: "0" }] }),
    groupCall("gentle_review_capture_group", [JSON.stringify(providerBinding()), providerBinding()]),
  ] as const
  for (const event of cases) {
    const before = JSON.stringify(event)
    const result = await run(event)
    assert.equal(result, undefined, `${event.toolName}: expected no block, got ${JSON.stringify(result)}`)
    assert.equal(JSON.stringify(event), before, `${event.toolName}: expected a byte-identical pass-through`)
  }
})

test("blocks a malformed JSON string binding and names the field", async () => {
  const run = handler()
  const malformed = '{"arguments":[{"name":"order","token":"--order=0","value":"0"}],"extra":}}'
  const event = captureCall("gentle_review_capture", malformed)
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected the malformed string to be blocked")
  assert.match(result?.reason ?? "", /collectBinding\b/)
  assert.match(result?.reason ?? "", /JSON/i, "reason must name the invalid JSON")
  assert.match(result?.reason ?? "", /verbatim/i, "reason must ask for a verbatim re-copy")
  assert.deepEqual(event, before, "the guard must never change the call")
})

test("blocks a malformed JSON string inside a group and names its index", async () => {
  const run = handler()
  const malformed = '{"name":"reviewer_result",}}'
  const event = groupCall("gentle_review_capture_group", [JSON.stringify(providerBinding()), malformed])
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected the malformed group member to be blocked")
  assert.match(result?.reason ?? "", /collectBindings\[1\]/)
  assert.match(result?.reason ?? "", /JSON/i)
  assert.match(result?.reason ?? "", /verbatim/i)
  assert.deepEqual(event, before, "the guard must never change the call")
})

test("blocks a serialized binding whose payload retypes a scalar to a number", async () => {
  const run = handler()
  const retyped = JSON.stringify({ ...providerBinding(), value: 1 })
  const event = captureCall("gentle_review_capture", retyped)
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected the retyped serialized binding to be blocked")
  assert.match(result?.reason ?? "", /"value"/, "reason must name the offending key")
  assert.match(result?.reason ?? "", /\bnumber 1\b/, "reason must name the offending value")
  assert.match(result?.reason ?? "", /verbatim/i)
  assert.deepEqual(event, before, "the guard must never change the call")
})

// MiniMax retypes nested scalars, not just top-level ones: "0" arrives as 0 and "true" as true
// inside arguments[i]. The controller then rejects the call as "missing or stale for current STATUS"
// without naming a cause, which is the expensive way to learn the same thing.
test("repairs a nested retyped scalar whose token confirms the value", async () => {
  const run = handler()
  const object = issuedBinding()
  object.arguments[1] = { ...object.arguments[1], value: 0 }
  object.arguments[2] = { ...object.arguments[2], value: true }
  const event = captureCall("gentle_review_capture", object)
  const result = await run(event)
  assert.equal(result, undefined, `expected a pass-through, got ${JSON.stringify(result)}`)
  assert.equal(event.input.collectBinding.arguments[1].value, "0", "the object form is repaired in place")
  assert.equal(event.input.collectBinding.arguments[2].value, "true", "both retyped scalars are repaired")

  const serialized = issuedBinding()
  serialized.arguments[1] = { ...serialized.arguments[1], value: 0 }
  serialized.arguments[2] = { ...serialized.arguments[2], value: true }
  const sEvent = captureCall("gentle_review_capture", JSON.stringify(serialized))
  const sResult = await run(sEvent)
  assert.equal(sResult, undefined, `expected a pass-through, got ${JSON.stringify(sResult)}`)
  const repaired = JSON.parse(sEvent.input.collectBinding)
  assert.equal(repaired.arguments[1].value, "0", "the serialized form is re-serialized with the repair")
  assert.equal(repaired.arguments[2].value, "true")
})

test("blocks a retyped value whose token does not confirm it", async () => {
  const run = handler()
  const binding = issuedBinding()
  binding.arguments[1] = { name: "order", token: "--order=9", value: 0 }
  const event = captureCall("gentle_review_capture", binding)
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected the unconfirmable retyped value to be blocked")
  assert.match(result?.reason ?? "", /arguments\[1\]\.value/)
  assert.match(result?.reason ?? "", /verbatim/i)
  assert.deepEqual(event, before, "the guard must not change an unrepairable call")
})

test("passes the fields the contract issues as numbers", async () => {
  const run = handler()
  for (const candidate of [issuedBinding(), JSON.stringify(issuedBinding())]) {
    const event = captureCall("gentle_review_capture", candidate)
    const result = await run(event)
    assert.equal(result, undefined, `expected no block, got ${JSON.stringify(result)}`)
  }
})

test("blocks a binding that is not a string at all", async () => {
  const run = handler()
  const event = captureCall("gentle_review_capture", 7)
  const before = structuredClone(event)
  const result = (await run(event)) as { block?: boolean; reason?: string } | undefined
  assert.equal(result?.block, true, "expected a non-string binding to be blocked")
  assert.match(result?.reason ?? "", /verbatim/i)
  assert.deepEqual(event, before, "the guard must never change the call")
})

test("passes a serialized JSON string binding through unchanged", async () => {
  const run = handler()
  const serialized = JSON.stringify(providerBinding())
  const event = captureCall("gentle_review_capture", serialized)
  const result = await run(event)
  assert.equal(result, undefined, `expected no block, got ${JSON.stringify(result)}`)
  assert.equal(event.input.collectBinding, serialized, "the string binding was re-serialized")
  const group = groupCall("gentle_review_capture_group", [serialized])
  assert.equal(await run(group), undefined)
  assert.equal(group.input.collectBindings[0], serialized, "the string binding was re-serialized")
})

test("leaves every other tool untouched, however its arguments look", async () => {
  const run = handler()
  const retyped = { ...providerBinding(), value: 1 }
  const cases = [
    ["gentle_review START", { toolName: "gentle_review", input: { operation: "start", input: { mode: "ordinary", lenses: "risk", committedOnly: 1 } } }],
    ["bash", { toolName: "bash", input: { command: "value 1 true" } }],
    ["lookalike tool name", { toolName: "gentle_review_capture_preview", input: { lineageId: LINEAGE, collectBinding: retyped } }],
    ["unrelated input shape", { toolName: "gentle_review_capture_group", input: { lineageId: LINEAGE, collectBindings: retyped } }],
  ] as const
  for (const [id, event] of cases) {
    const before = JSON.stringify(event)
    const result = await run(event)
    assert.equal(result, undefined, `${id}: expected no block, got ${JSON.stringify(result)}`)
    assert.equal(JSON.stringify(event), before, `${id}: expected no mutation`)
  }
})

test("passes through instead of blocking when an internal check fails", async () => {
  const run = handler()
  const binding: Record<string, unknown> = { name: "reviewer_result" }
  Object.defineProperty(binding, "captureOperation", {
    enumerable: true,
    get() {
      throw new Error("binding getter exploded")
    },
  })
  const input = { lineageId: LINEAGE, collectBinding: binding }
  const event = { toolName: "gentle_review_capture", input }
  const result = await run(event)
  assert.equal(result, undefined, "a failed check must fail open")
  assert.equal(event.input, input, "the input object must not be replaced")
  assert.equal(event.input.collectBinding, binding, "the binding must not be replaced")
  assert.equal(event.input.lineageId, LINEAGE)
})

test("writes one debug line for a blocked call only under the debug env var", async () => {
  const run = handler()
  const retyped = () => captureCall("gentle_review_capture", { ...providerBinding(), value: 1 })
  const withDebug = await captureStderr(async () => {
    process.env.GENTLE_AI_DEBUG_BINDING_GUARD = "1"
    try {
      await run(retyped())
    } finally {
      delete process.env.GENTLE_AI_DEBUG_BINDING_GUARD
    }
  })
  assert.equal(withDebug.length, 1, `expected one stderr line, got ${JSON.stringify(withDebug)}`)
  assert.match(withDebug[0]!, /^\[gentle-review-capture-guard] /)
  assert.match(withDebug[0]!, /"value"/)
  const withoutDebug = await captureStderr(() => run(retyped()))
  assert.deepEqual(withoutDebug, [], "nothing is written without the debug env var")
})

test("writes one debug line for each new violation kind", async () => {
  const run = handler()
  const cases = [
    ["invalid JSON", captureCall("gentle_review_capture", '{"name":}}')],
    ["retyped scalar inside a string", captureCall("gentle_review_capture", JSON.stringify({ ...providerBinding(), value: 1 }))],
    ["not a string", captureCall("gentle_review_capture", 7)],
  ] as const
  for (const [id, event] of cases) {
    const lines = await captureStderr(async () => {
      process.env.GENTLE_AI_DEBUG_BINDING_GUARD = "1"
      try {
        await run(event)
      } finally {
        delete process.env.GENTLE_AI_DEBUG_BINDING_GUARD
      }
    })
    assert.equal(lines.length, 1, `${id}: expected one stderr line, got ${JSON.stringify(lines)}`)
    assert.match(lines[0]!, /^\[gentle-review-capture-guard] /, id)
  }
})

test("passes a correction-plan binding whose minimum and maximum are contract numbers", async () => {
  const run = handler()
  const binding = issuedBinding()
  binding.submission.values = [{ ...binding.submission.values[0]!, maximum: 200, minimum: 1 }]
  const event = captureCall("gentle_review_capture", binding)
  const before = structuredClone(event)
  const result = await run(event)
  assert.equal(result, undefined, `expected no block, got ${JSON.stringify(result)}`)
  assert.deepEqual(event, before)
})