import { test } from "node:test"
import assert from "node:assert/strict"
import register from "../extensions/gentle-review-start-repair.ts"

// Deterministic coverage for the local workaround of Gentleman-Programming/gentle-shell#2280.
// The real extension is loaded through its default export with a fake ExtensionAPI, and its
// registered `tool_call` handler is driven with synthetic events: no model, no repository and no
// review authority involved.
const LENSES = ["review-risk", "review-resilience", "review-readability", "review-reliability"]

type Handler = (event: unknown) => unknown
function handler(): Handler {
  const registrations: Array<{ name: string; handler: Handler }> = []
  register({ on: (name: string, h: Handler) => (registrations.push({ name, handler: h }), () => {}) } as never)
  const found = registrations.find((entry) => entry.name === "tool_call")
  assert.ok(found, "extension did not register a tool_call handler")
  return found.handler
}

const reviewCall = (operation: string, input?: unknown) => ({
  toolName: "gentle_review",
  input: input === undefined ? { operation } : { operation, input },
})

const validPayload = (text: unknown): string | undefined => {
  if (typeof text !== "string") return "input was not re-serialized to a JSON string"
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return `not JSON: ${(error as Error).message}`
  }
  const { lenses, lensesReason } = parsed
  if (!Array.isArray(lenses) || lenses.length === 0) return "lenses is not a non-empty array"
  if (!lenses.every((lens) => LENSES.includes(lens))) return `lenses outside the native set: ${JSON.stringify(lenses)}`
  if (new Set(lenses).size !== lenses.length) return "lenses contains duplicates"
  if (typeof lensesReason !== "string" || lensesReason.trim() === "") return "lensesReason is not a non-empty string"
  if (/[\r\n]/.test(lensesReason)) return "lensesReason contains a newline"
  if (Buffer.byteLength(lensesReason, "utf8") > 500) return "lensesReason exceeds 500 bytes"
  return undefined
}

const longReason = "detail ".repeat(100)

test("repairs every mangled lens shape before the tool runs", async () => {
  const cases = [
    ["R1 comma string (object form)", { mode: "ordinary", lenses: "risk,reliability", lensesReason: "probe", baseRef: "2b143b1" }],
    ["R2 JSON-array string", { mode: "ordinary", lenses: '["review-risk","review-readability"]', lensesReason: "probe" }],
    ["R3 serialized string input", JSON.stringify({ mode: "ordinary", lenses: "risk, reliability", lensesReason: "probe" })],
    ["R4 duplicated array", { mode: "ordinary", lenses: ["risk", "risk", "reliability"], lensesReason: "probe" }],
    ["R5 case/space padded names", { mode: "ordinary", lenses: [" Risk ", "RELIABILITY"], lensesReason: "probe" }],
    ["R6 array with non-strings", { mode: "ordinary", lenses: ["risk", "banana", 42, null], lensesReason: "probe" }],
    ["R7 unusable lenses string", { mode: "ordinary", lenses: "banana", lensesReason: "probe" }],
    ["R8 lenses object shape", { mode: "ordinary", lenses: { 0: "risk" }, lensesReason: "probe" }],
    ["R9 missing reason", { mode: "ordinary", lenses: ["risk"] }],
    ["R10 reason with newline", { mode: "ordinary", lenses: ["risk"], lensesReason: "line one\nline two" }],
    ["R11 reason over 500 bytes", { mode: "ordinary", lenses: ["risk"], lensesReason: longReason }],
    ["R12 reason without lenses", { mode: "ordinary", lensesReason: "probe" }],
  ] as const
  const run = handler()
  for (const [id, payload] of cases) {
    const event = reviewCall("start", payload)
    const before = structuredClone(event)
    await run(event)
    assert.notEqual(JSON.stringify(event), JSON.stringify(before), `${id}: expected a repair`)
    const failure = validPayload((event.input as any).input)
    assert.equal(failure, undefined, `${id}: ${failure}`)
    const original = typeof before.input.input === "string" ? JSON.parse(before.input.input) : before.input.input
    const repaired = JSON.parse((event.input as any).input)
    for (const key of Object.keys(original)) {
      if (key === "lenses" || key === "lensesReason") continue
      assert.equal(JSON.stringify(repaired[key]), JSON.stringify(original[key]), `${id}: unrelated field ${key} changed`)
    }
  }
})

test("leaves anything that is not a repairable ordinary START untouched", async () => {
  const cases = [
    ["U1 another tool", { toolName: "bash", input: { command: "true" } }],
    ["U2 operation assess", reviewCall("assess", { baseRef: "HEAD", committedOnly: true })],
    ["U3 operation status", reviewCall("status", { mode: "ordinary", lenses: "risk,reliability" })],
    ["U4 operation answer-consent", reviewCall("answer-consent", { consentBinding: "opaque", answer: "granted" })],
    ["U5 focus present", reviewCall("start", { mode: "ordinary", focus: "security", lenses: "risk,reliability", lensesReason: "probe" })],
    ["U6 submission binding", reviewCall("start", { mode: "ordinary", submission: { value: "{}" }, lenses: "risk" })],
    ["U7 non-ordinary mode", reviewCall("start", { mode: "verify-fix", lenses: "risk,reliability", lensesReason: "probe" })],
    ["U8 neither lens field", reviewCall("start", { mode: "ordinary", baseRef: "2b143b1" })],
    ["U9 malformed JSON string", reviewCall("start", '{"mode":"ordinary",')],
    ["U10 already canonical", reviewCall("start", { mode: "ordinary", lenses: [...LENSES], lensesReason: "what I touched" })],
    ["U11 no input field", reviewCall("start")],
    ["U12 no operation", { toolName: "gentle_review", input: { input: { mode: "ordinary", lenses: "risk" } } }],
    ["U13 non-object input", reviewCall("start", 42)],
  ] as const
  const run = handler()
  for (const [id, event] of cases) {
    const before = structuredClone(event)
    await run(event)
    assert.equal(JSON.stringify(event), JSON.stringify(before), `${id}: expected no mutation`)
  }
})

test("normalizes committedOnly only for a repairable ordinary START", async () => {
  const cases = [
    ["K1 string true", "start", { mode: "ordinary", baseRef: "0".repeat(40), committedOnly: "true", lenses: [...LENSES], lensesReason: "probe" }, true],
    ["K2 string false", "start", { mode: "ordinary", committedOnly: "false" }, "deleted"],
    ["K3 number 1", "start", { mode: "ordinary", committedOnly: 1 }, true],
    ["K4 number 0", "start", { mode: "ordinary", committedOnly: 0 }, "deleted"],
    ["K5 unknown string", "start", { mode: "ordinary", baseRef: "0".repeat(40), committedOnly: "yes", lenses: [...LENSES], lensesReason: "probe" }, "unchanged"],
    ["K6 lenses and committedOnly", "start", { mode: "ordinary", baseRef: "0".repeat(40), committedOnly: "TRUE", lenses: "risk,reliability", lensesReason: "probe" }, true],
    ["K7 already boolean", "start", { mode: "ordinary", baseRef: "0".repeat(40), committedOnly: true, lenses: [...LENSES], lensesReason: "probe" }, "unchanged"],
    ["K8 assess untouched", "assess", { baseRef: "HEAD", committedOnly: "true" }, "unchanged"],
  ] as const
  const run = handler()
  for (const [id, operation, payload, expected] of cases) {
    const event = reviewCall(operation, payload)
    const before = structuredClone(event)
    await run(event)
    const unchanged = JSON.stringify(event) === JSON.stringify(before)
    const parsed = unchanged ? undefined : JSON.parse((event.input as any).input)
    if (expected === "unchanged") assert.ok(unchanged, `${id}: expected no mutation, got ${JSON.stringify(parsed)}`)
    if (expected === true) assert.equal(parsed?.committedOnly, true, `${id}: committedOnly is ${JSON.stringify(parsed?.committedOnly)}`)
    if (expected === "deleted") assert.ok(parsed !== undefined && !("committedOnly" in parsed), `${id}: committedOnly not deleted`)
    if (parsed !== undefined) assert.equal(JSON.stringify(parsed.baseRef), JSON.stringify(payload.baseRef), `${id}: baseRef changed`)
  }
})

// Envelope repair: the observed MiniMax failure relocates the tool's own top-level parameters
// inside `input`, so the handler above bails out at `parameters.operation !== "start"` and the
// controller answers "operation: must have required properties operation". These cases pin the
// hoisting rule: recognised keys move back up only when their top-level slot is empty.
const ENVELOPE_KEYS = ["operation", "input", "baseRef", "committedOnly", "idempotencyKey", "workspaceRoot"] as const

test("hoists the relocated tool parameters back to the top level", async () => {
  const payload = { mode: "ordinary", baseRef: "0".repeat(40), committedOnly: true, lenses: "risk,reliability", lensesReason: "probe" }
  const event = {
    toolName: "gentle_review",
    input: { input: { operation: "start", baseRef: payload.baseRef, committedOnly: true, input: payload } },
  }
  await handler()(event)
  const parameters = event.input as any
  assert.equal(parameters.operation, "start", "operation was not hoisted")
  assert.equal(parameters.baseRef, payload.baseRef, "baseRef was not hoisted")
  assert.equal(parameters.committedOnly, true, "committedOnly was not hoisted")
  const parsed = typeof parameters.input === "string" ? JSON.parse(parameters.input) : parameters.input
  assert.deepEqual(parsed.lenses, ["review-risk", "review-reliability"], `lenses were not repaired: ${JSON.stringify(parsed.lenses)}`)
})

test("leaves a call alone when the top level already carries its own parameters", async () => {
  const event = reviewCall("start", { mode: "ordinary", lenses: [...LENSES], lensesReason: "probe" })
  const before = structuredClone(event)
  await handler()(event)
  assert.deepEqual(event.input, before.input, "a well-formed call was modified")
})

test("hoists nothing for a tool other than gentle_review", async () => {
  const event = { toolName: "bash", input: { input: { operation: "start", input: { mode: "ordinary" } } } }
  const before = structuredClone(event)
  await handler()(event)
  assert.deepEqual(event.input, before.input, "another tool was modified")
})

test("does not hoist a key the caller already set at the top level", async () => {
  const event = { toolName: "gentle_review", input: { operation: "status", input: { operation: "start", baseRef: "HEAD" } } }
  await handler()(event)
  const parameters = event.input as any
  assert.equal(parameters.operation, "status", "an explicit top-level operation was overwritten")
  assert.equal(parameters.baseRef, undefined, "baseRef was hoisted even though the top level did not name one")
})

test("every recognised envelope key survives a round trip", async () => {
  for (const key of ENVELOPE_KEYS) {
    const nested: Record<string, unknown> = { operation: "status" }
    if (key !== "operation") nested[key] = key === "committedOnly" ? true : `value-${key}`
    const event = { toolName: "gentle_review", input: { input: nested } }
    await handler()(event)
    const parameters = event.input as any
    if (key === "operation") assert.equal(parameters.operation, "status", `${key} was not hoisted`)
    else assert.equal(parameters[key], nested[key], `${key} was not hoisted`)
  }
})
