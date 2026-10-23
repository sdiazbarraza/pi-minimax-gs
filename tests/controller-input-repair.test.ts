import { test } from "node:test"
import assert from "node:assert/strict"
import register from "../extensions/gentle-review-controller-input-repair.ts"
import captureGuard from "../extensions/gentle-review-capture-guard.ts"

// Deterministic coverage for the controller-input repair. The extension is loaded through its
// default export with a fake ExtensionAPI and its registered `tool_call` handler is driven with
// synthetic events: no model, no provider and no review authority involved.
//
// The review controller reads its `input` argument as a serialized object string for every
// operation except START and ASSESS. A provider whose tool-argument serialization emits the object
// form makes the call fail with "Review controller input must be a string", and the lineage stalls
// on `status`, `answer-consent` and `acknowledge-approved` without ever naming the cause. The
// repair re-serializes that object, but only when it is provably lossless: the same checks the
// controller's own `serializeReviewJsonArgument` makes, so a payload the controller would reject is
// left untouched and still rejected with its cause named.
type Handler = (event: unknown) => unknown
function handler(): Handler {
  const registrations: Array<{ name: string; handler: Handler }> = []
  register({ on: (name: string, h: Handler) => (registrations.push({ name, handler: h }), () => {}) } as never)
  const found = registrations.find((entry) => entry.name === "tool_call")
  assert.ok(found, "extension did not register a tool_call handler")
  return found.handler
}

/** A `gentle_review` call whose `input` is the given value. */
const reviewCall = (operation: string, input?: unknown) => ({
  toolName: "gentle_review",
  input: { operation, input },
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

// Every operation the controller reads `input` from as a JSON string. START and ASSESS are the two
// that already accept the object form and are therefore not repaired.
const STRING_ONLY_OPERATIONS = [
  "status",
  "answer-consent",
  "acknowledge-approved",
  "advance",
  "export",
  "inspect",
  "reset",
  "abandon",
  "import",
  "recover",
  "recover-lock",
  "quarantine-legacy",
  "reconcile-authority",
  "repair-legacy-alias",
] as const

test("re-serializes an object input for every operation that requires a JSON string", async () => {
  const run = handler()
  const payload = {
    mode: "ordinary",
    baseRef: "a".repeat(40),
    committedOnly: false,
    nested: { list: [1, 2, { deep: "value" }], flag: true, nothing: null },
  }
  for (const operation of STRING_ONLY_OPERATIONS) {
    const event = reviewCall(operation, payload)
    const result = await run(event)
    assert.equal(result, undefined, `${operation}: the call must never be blocked`)
    const written = (event.input as any).input
    assert.equal(typeof written, "string", `${operation}: the object input was not re-serialized`)
    assert.deepEqual(JSON.parse(written), payload, `${operation}: the re-serialized content differs`)
    assert.equal(JSON.stringify(JSON.parse(written)), JSON.stringify(payload), `${operation}: the key order changed`)
  }
})

test("rewrites only the input slot of the call", async () => {
  const run = handler()
  const event = {
    toolName: "gentle_review",
    input: { operation: "status", lineageId: "lin_1", input: { mode: "ordinary" }, baseRef: "b".repeat(40) },
  }
  const before = event.input
  await run(event)
  assert.equal(event.input, before, "the parameter object must not be replaced")
  assert.equal(event.input.operation, "status", "the operation changed")
  assert.equal(event.input.lineageId, "lin_1", "the lineageId changed")
  assert.equal(event.input.baseRef, "b".repeat(40), "an unrelated parameter changed")
  assert.equal(typeof event.input.input, "string", "the input was not re-serialized")
})

test("leaves a string input byte-identical", async () => {
  const run = handler()
  const serialized = JSON.stringify({ mode: "ordinary" })
  const event = reviewCall("status", serialized)
  const before = structuredClone(event)
  await run(event)
  assert.deepEqual(event, before, "a string input was re-serialized")
})

test("leaves the object form alone for start and assess", async () => {
  const run = handler()
  for (const operation of ["start", "assess"]) {
    const event = reviewCall(operation, { mode: "ordinary", baseRef: "a".repeat(40) })
    const before = structuredClone(event)
    await run(event)
    assert.deepEqual(event, before, `${operation}: the accepted object form was rewritten`)
  }
})

test("leaves a call without a usable input alone", async () => {
  const run = handler()
  const cases = [
    ["absent input", { toolName: "gentle_review", input: { operation: "status" } }],
    ["number input", reviewCall("status", 42)],
    ["array input", reviewCall("status", [{ mode: "ordinary" }])],
    ["empty object input", reviewCall("status", {})],
    ["null input", reviewCall("status", null)],
    ["string operation", reviewCall("status", "not-an-object")],
    ["another tool", { toolName: "bash", input: { operation: "status", input: { mode: "ordinary" } } }],
    ["missing operation", { toolName: "gentle_review", input: { input: { mode: "ordinary" } } }],
    ["non-string operation", { toolName: "gentle_review", input: { operation: 7, input: { mode: "ordinary" } } }],
  ] as const
  for (const [id, event] of cases) {
    const before = structuredClone(event)
    const result = await run(event)
    assert.equal(result, undefined, `${id}: the call must never be blocked`)
    assert.deepEqual(event, before, `${id}: expected no mutation`)
  }
})

test("leaves a payload the controller would reject untouched", async () => {
  const run = handler()
  const cyclic: Record<string, unknown> = { mode: "ordinary" }
  cyclic.self = cyclic
  const withGetter: Record<string, unknown> = { mode: "ordinary" }
  Object.defineProperty(withGetter, "baseRef", {
    enumerable: true,
    get() {
      throw new Error("payload getter exploded")
    },
  })
  const cases: Array<[string, unknown]> = [
    ["an undefined value", { mode: "ordinary", baseRef: undefined }],
    ["a NaN value", { mode: "ordinary", score: Number.NaN }],
    ["an infinite value", { mode: "ordinary", score: Number.POSITIVE_INFINITY }],
    ["a negative zero", { mode: "ordinary", score: -0 }],
    ["a getter", withGetter],
    ["a symbol key", { mode: "ordinary", [Symbol("secret")]: "value" }],
    ["a non-plain nested object", { mode: "ordinary", when: new Date(0) }],
    ["a class instance", { mode: "ordinary", nested: new (class Nested { value = 1 })() }],
    ["a cycle", cyclic],
    ["a sparse array", { mode: "ordinary", list: [, "second"] }],
    ["an extended array", Object.assign([1], { extra: true })],
  ]
  for (const [id, payload] of cases) {
    const event = reviewCall("status", payload)
    const before = (event.input as any).input
    await run(event)
    assert.equal((event.input as any).input, before, `${id}: the payload was replaced`)
    assert.equal(typeof (event.input as any).input, "object", `${id}: the payload was re-serialized`)
  }
})

test("passes the call through unchanged when a property access throws", async () => {
  const run = handler()
  const throwingOperation: Record<string, unknown> = { input: { mode: "ordinary" } }
  Object.defineProperty(throwingOperation, "operation", {
    enumerable: true,
    get() {
      throw new Error("operation getter exploded")
    },
  })
  const throwingInput: Record<string, unknown> = { operation: "status" }
  Object.defineProperty(throwingInput, "input", {
    enumerable: true,
    get() {
      throw new Error("input getter exploded")
    },
  })
  for (const [id, parameters] of [
    ["a throwing operation", throwingOperation],
    ["a throwing input", throwingInput],
  ] as const) {
    const event = { toolName: "gentle_review", input: parameters }
    const lines = await captureStderr(() => run(event))
    assert.deepEqual(lines, [], `${id}: a swallowed error must stay silent`)
    assert.equal(event.input, parameters, `${id}: the parameter object must not be replaced`)
  }
})

test("writes one debug line per repair under the debug env var and nothing without it", async () => {
  const run = handler()
  const withDebug = await captureStderr(async () => {
    process.env.GENTLE_AI_DEBUG_CONTROLLER_INPUT = "1"
    try {
      await run(reviewCall("status", { mode: "ordinary" }))
    } finally {
      delete process.env.GENTLE_AI_DEBUG_CONTROLLER_INPUT
    }
  })
  assert.equal(withDebug.length, 1, `expected one stderr line, got ${JSON.stringify(withDebug)}`)
  assert.match(withDebug[0]!, /^\[gentle-review-controller-input-repair] /)
  assert.match(withDebug[0]!, /status/)
  const withoutDebug = await captureStderr(() => run(reviewCall("status", { mode: "ordinary" })))
  assert.deepEqual(withoutDebug, [], "nothing is written without the debug env var")
})

// Pi runs every `tool_call` handler of every extension in one chain and keeps the first result
// that carries `block` (ExtensionRunner.emitToolCall). A third handler that returns nothing must
// not take that block down, in either registration order.
test("never undoes the block of another extension in the same chain", async () => {
  const captureCall = () => ({
    toolName: "gentle_review_capture",
    input: { lineageId: "lin_1", collectBinding: { name: "reviewer_result", value: 1 } },
  })
  for (const order of [["capture", "repair"], ["repair", "capture"]] as const) {
    const registrations: Array<{ name: string; handler: Handler }> = []
    const load = (extension: (pi: never) => void) =>
      extension({ on: (name: string, h: Handler) => (registrations.push({ name, handler: h }), () => {}) } as never)
    for (const which of order) load(which === "capture" ? captureGuard : register)
    const event = captureCall()
    let result: { block?: boolean; reason?: string } | undefined
    for (const { name, handler: run } of registrations) {
      if (name !== "tool_call") continue
      const handlerResult = (await run(event, {})) as { block?: boolean; reason?: string } | undefined
      if (handlerResult) {
        result = handlerResult
        if (result.block) break
      }
    }
    assert.equal(result?.block, true, `order ${order.join(",")}: the capture guard's block was lost`)
    assert.match(result?.reason ?? "", /"value"/, `order ${order.join(",")}: the block reason changed`)
  }
})
