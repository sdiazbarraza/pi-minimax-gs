// gentle-review-capture-guard — local Pi extension, tripwire for a rewritten capture binding.
// Evaluation: `odd/tasks/capture-binding-tripwire-evaluation.md` (gentle-shell-parch working copy,
// 2026-10-18). Delete this file once the mirrored contract stops needing the reminder.
//
// Why: a provider-issued collect binding is opaque and its digest is checked by the tooling, so an
// agent that rewrote it — putting the number 1 or the boolean true where the provider emitted the
// string "1" or "true" — can only answer `capture-binding-rejected`, and the rejection never names
// the cause. One session burned five blind retries on it.
//
// What: a `tool_call` handler that inspects `collectBinding` and each item of `collectBindings` of
// `gentle_review_capture` / `gentle_review_capture_group`, and blocks a binding that was rewritten.
// Four causes are named:
//   1. a scalar that arrived as a number or a boolean where the contract issues a string, anywhere
//      in the binding: MiniMax rewrites the nested `arguments[i].value` first ("0" to 0, "true" to
//      true), and a top-level scan sees nothing;
//   2. the same retyped scalar inside a serialized binding whose payload was rewritten;
//   3. a string that is not valid JSON (a mangled string, e.g. one stray closing brace);
//   4. a binding that is neither a string nor an object.
// The object form is accepted: the tool schema takes an object or the issued string, and the bytes
// that reach the controller are the same either way. Whitespace is not what the controller checks;
// only a retyped value is.
//
// Never repairs a value: a retyped scalar can only be restored by the agent that owns the issued
// bytes, and guessing one would mint a second wrong binding. The block names the exact path and the
// value and asks for a verbatim re-copy; no code path writes `event.input` or any binding.
//
// Scope: those two tools and those two fields only. A serialized JSON string binding is parsed to
// validate it, but it is never re-serialized, normalized or replaced.
//
// Fail-open: every path is wrapped, so an internal error passes the call through unchanged and the
// controller reports its own rejection, like gentle-review-start-repair.ts.
//
// Debug: `GENTLE_AI_DEBUG_BINDING_GUARD=1` writes one stderr line per block or swallowed failure.
// Install: it ships inside the `pi-warden-gs` package and is registered in its `package.json`
// (`pi.extensions`), so Pi loads `extensions/gentle-review-capture-guard.ts` from this package at
// startup; `/reload` activates it in a session that is already open.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The only two tools whose bindings are inspected. */
export const CAPTURE_TOOLS: readonly string[] = ["gentle_review_capture", "gentle_review_capture_group"];

const DEBUG_ENV = "GENTLE_AI_DEBUG_BINDING_GUARD";

/** Every cause the guard can name, one per blocking rule. */
export type CaptureBindingViolationKind =
	| "retyped-scalar"
	| "retyped-scalar-in-string"
	| "invalid-json"
	| "not-a-string";

export interface CaptureBindingViolation {
	/** The inspected field, as the call spells it. */
	readonly field: "collectBinding" | "collectBindings";
	/** Position inside `collectBindings`; -1 for the single `collectBinding`. */
	readonly index: number;
	/** Which rule fired. */
	readonly kind: CaptureBindingViolationKind;
	/** Exact path of the scalar that arrived as a number or a boolean, e.g. `arguments[1].value`. */
	readonly key?: string;
	readonly value?: number | boolean;
	/** Extra context: the JSON parse error, or the type of a non-string binding. */
	readonly detail?: string;
}

/**
 * The keys a collect binding issues as numbers by contract. Every other scalar in a binding is a
 * string, so a number or a boolean at any other key is a retyped value and a byte mismatch. Add a
 * key here when the contract starts issuing that field as a number.
 */
const NUMERIC_BINDING_KEYS: ReadonlySet<string> = new Set(["selectedOrder", "substitutionLocation"]);

/**
 * The first scalar of `binding` that arrived as a number or a boolean where the contract issues a
 * string, named by its exact path (`arguments[1].value`), or undefined when the binding carries none.
 * Depth matters: a tool layer that retypes strings rewrites the nested `arguments[i].value` first,
 * where a top-level scan sees nothing. Pure and read-only: it writes nothing, and it raises only when
 * reading a binding throws (a hostile getter), which the caller turns into a pass-through.
 */
export function retypedBindingScalar(binding: unknown): { key: string; value: number | boolean } | undefined {
	return firstRetypedScalar(binding, "");
}

function firstRetypedScalar(value: unknown, path: string): { key: string; value: number | boolean } | undefined {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const offender = firstRetypedScalar(value[index], `${path}[${index}]`);
			if (offender !== undefined) return offender;
		}
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		if ((typeof value === "number" || typeof value === "boolean") && !NUMERIC_BINDING_KEYS.has(keyOf(path))) {
			return { key: path, value: value as number | boolean };
		}
		return undefined;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const offender = firstRetypedScalar(child, path === "" ? key : `${path}.${key}`);
		if (offender !== undefined) return offender;
	}
	return undefined;
}

/** The last path segment of a walked path, which is the key a scalar arrived under. */
function keyOf(path: string): string {
	const match = /(?:^|\.)([^.[\]]+)$/.exec(path);
	return match === null ? path : match[1];
}

/**
 * The rule that fires for one binding value, or undefined when the value is exactly what the
 * provider issued: one string that parses as JSON. Read-only: it never writes the binding.
 */
function bindingViolation(
	field: "collectBinding" | "collectBindings",
	index: number,
	binding: unknown,
): CaptureBindingViolation | undefined {
	if (typeof binding === "string") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(binding);
		} catch (error) {
			return {
				field,
				index,
				kind: "invalid-json",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		const offender = retypedBindingScalar(parsed);
		return offender === undefined
			? undefined
			: { field, index, kind: "retyped-scalar-in-string", key: offender.key, value: offender.value };
	}
	if (typeof binding === "object" && binding !== null && !Array.isArray(binding)) {
		// The tool schema takes an object or the issued string, and the controller accepts both, so an
		// all-string object is legitimate: only a retyped scalar inside it is a rewrite.
		const offender = retypedBindingScalar(binding);
		return (
			offender === undefined
				? undefined
				: { field, index, kind: "retyped-scalar", key: offender.key, value: offender.value }
		);
	}
	return { field, index, kind: "not-a-string", detail: typeof binding };
}

/**
 * The first retyped binding a capture call carries, or undefined when it carries none. `collectBinding`
 * is inspected first, then each item of `collectBindings` in the order the call declares them.
 */
export function findCaptureBindingViolation(toolName: string, input: unknown): CaptureBindingViolation | undefined {
	if (!CAPTURE_TOOLS.includes(toolName)) return undefined;
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const parameters = input as Record<string, unknown>;
	if (parameters.collectBinding !== undefined) {
		const single = bindingViolation("collectBinding", -1, parameters.collectBinding);
		if (single !== undefined) return single;
	}
	const group = parameters.collectBindings;
	if (!Array.isArray(group)) return undefined;
	for (let index = 0; index < group.length; index += 1) {
		const offender = bindingViolation("collectBindings", index, group[index]);
		if (offender !== undefined) return offender;
	}
	return undefined;
}

/** The cause of one violation, in one sentence. */
function causeSentence(violation: CaptureBindingViolation): string {
	switch (violation.kind) {
		case "retyped-scalar":
			return (
				`carries the ${typeof violation.value} ${String(violation.value)} at "${violation.key}", where the ` +
				"contract issues a string: the tool layer retyped it, so the binding no longer matches the bytes " +
				"the provider issued"
			);
		case "retyped-scalar-in-string":
			return (
				`carries the ${typeof violation.value} ${String(violation.value)} at "${violation.key}" inside the ` +
				"serialized binding, where the contract issues a string: the tool layer retyped the payload, so " +
				"it no longer matches the bytes the provider issued"
			);
		case "invalid-json":
			return (
				`is not valid JSON (${violation.detail}): the string was mangled on the way in, ` +
				"so the provider cannot match it"
			);
		case "not-a-string":
			return `arrives as a ${violation.detail} instead of the exact string the provider issued`;
	}
}

/** The block message: the cause, the key, the value, and the only correct repair — a verbatim re-copy. */
export function captureBindingBlockReason(toolName: string, violation: CaptureBindingViolation): string {
	const where = violation.field === "collectBinding" ? "collectBinding" : `collectBindings[${violation.index}]`;
	return (
		`gentle-review-capture-guard: ${toolName} is blocked because ${where} ${causeSentence(violation)}. ` +
		`Never repair, re-serialize or normalize it: run review status again, re-copy the binding verbatim exactly ` +
		`as the provider emitted it, and call ${toolName} once.`
	);
}

function debugLog(message: string): void {
	if (process.env[DEBUG_ENV] !== "1") return;
	try {
		process.stderr.write(`[gentle-review-capture-guard] ${message}\n`);
	} catch {
		// Observability must never affect the call.
	}
}

export default function gentleReviewCaptureGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		try {
			const violation = findCaptureBindingViolation(event.toolName, event.input);
			if (violation === undefined) return;
			const reason = captureBindingBlockReason(event.toolName, violation);
			debugLog(`blocked ${event.toolName}: ${reason}`);
			return { block: true, reason };
		} catch (error) {
			// Fail-open: an unobservable check must not cost the call its chance of succeeding.
			debugLog(`passed through unchanged after error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
