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
// `gentle_review_capture` / `gentle_review_capture_group`, and blocks a binding that is not the
// exact string the provider issued. Five causes are named:
//   1. a top-level scalar that mixes a string with a number or a boolean (a rewritten binding);
//   2. the same mix inside a serialized binding whose payload was rewritten;
//   3. a string that is not valid JSON (a mangled string, e.g. one stray closing brace);
//   4. a binding that arrives as an object instead of the issued string;
//   5. a binding that arrives as something other than a string or an object.
// Cause 4 is a change of the L28 evidence: the controller matches the issued bytes, so a
// re-serialized object copy is rejected downstream with "collectBindings must be the complete
// distinct current reviewer group in exact provider order", after the forecast already cost a
// call. Blocking it here names the cause instead of burning the call.
//
// Never repairs a value: the original is not in the extension, so guessing one would only mint a
// second wrong digest. The block names the key and the value and asks for a verbatim re-copy; no
// code path writes `event.input` or any binding.
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
	| "object-form"
	| "not-a-string";

export interface CaptureBindingViolation {
	/** The inspected field, as the call spells it. */
	readonly field: "collectBinding" | "collectBindings";
	/** Position inside `collectBindings`; -1 for the single `collectBinding`. */
	readonly index: number;
	/** Which rule fired. */
	readonly kind: CaptureBindingViolationKind;
	/** Key of the top-level scalar that arrived as a number or a boolean. */
	readonly key?: string;
	readonly value?: number | boolean;
	/** Extra context: the JSON parse error, or the type of a non-string binding. */
	readonly detail?: string;
}

/**
 * The first top-level scalar of `binding` that is a number or a boolean while at least one sibling
 * is a string, or undefined when the binding carries no such mix. Pure and read-only: it writes
 * nothing, and it raises only when reading a binding throws (a hostile getter), which the caller
 * turns into a pass-through.
 */
export function retypedBindingScalar(binding: unknown): { key: string; value: number | boolean } | undefined {
	if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return undefined;
	const entries = Object.entries(binding as Record<string, unknown>);
	if (!entries.some(([, value]) => typeof value === "string")) return undefined;
	const offender = entries.find(([, value]) => typeof value === "number" || typeof value === "boolean");
	return offender === undefined ? undefined : { key: offender[0], value: offender[1] as number | boolean };
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
		const offender = retypedBindingScalar(binding);
		return offender === undefined
			? { field, index, kind: "object-form" }
			: { field, index, kind: "retyped-scalar", key: offender.key, value: offender.value };
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
				`carries the ${typeof violation.value} ${String(violation.value)} at "${violation.key}" while its ` +
				"other scalars are strings: the binding was rewritten instead of re-sent, so its digest no longer matches"
			);
		case "retyped-scalar-in-string":
			return (
				`carries the ${typeof violation.value} ${String(violation.value)} at "${violation.key}" inside the ` +
				"serialized binding while its other scalars are strings: the payload was rewritten instead of re-sent, " +
				"so its digest no longer matches"
			);
		case "invalid-json":
			return (
				`is not valid JSON (${violation.detail}): the string was mangled on the way in, ` +
				"so the provider cannot match it"
			);
		case "object-form":
			return (
				"arrives as an object instead of the exact string the provider issued: the controller matches " +
				"the issued bytes, so a re-serialized copy is rejected downstream"
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
