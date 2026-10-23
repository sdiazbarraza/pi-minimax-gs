// gentle-review-capture-guard — local Pi extension, tripwire for a rewritten capture binding.
// Evaluation: `odd/tasks/capture-binding-tripwire-evaluation.md` (gentle-shell-parch working copy,
// 2026-10-18). Delete this file once the mirrored contract stops needing the reminder.
//
// Why: a provider-issued collect binding is opaque and its digest is checked by the tooling, so an
// agent that rewrote it — putting the number 0 or the boolean true where the provider emitted the
// string "0" or "true" — can only answer `capture-binding-rejected`, and the rejection never names
// the cause. MiniMax rewrites the nested `arguments[i].value` first, where a top-level scan sees
// nothing, and one review burned five blind retries on it.
//
// What: a `tool_call` handler that inspects `collectBinding` and each item of `collectBindings` of
// `gentle_review_capture` / `gentle_review_capture_group`, repairs a retyped value it can prove, and
// blocks a binding it cannot. The proof: each entry of `arguments` carries its own token, and
// `token === "--" + name + "=" + String(value)` holds exactly when the original value was
// `String(value)`, so the original is read back from the binding itself, never guessed. A retyped
// value that no token confirms, a string that is not valid JSON, and a binding that is neither a
// string nor an object are still blocked, each with its cause named.
//
// A binding may arrive as an object or as the issued string: the tool schema takes both and the
// controller canonicalizes both, so the object form is not a defect. An object is repaired in place;
// a serialized string is parsed, repaired and re-serialized to the provider's canonical form
// (compact, keys sorted), which is the byte layout the provider issues.
//
// Scope: those two tools and those two fields only. Nothing else is touched.
//
// Fail-open: every path is wrapped, so an internal error passes the call through unchanged and the
// controller reports its own rejection, like gentle-review-start-repair.ts.
//
// Debug: `GENTLE_AI_DEBUG_BINDING_GUARD=1` writes one stderr line per repair, block or swallowed
// failure.
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
 * key here when the contract starts issuing that field as a number. `minimum` and `maximum` are the
 * bounds of a correction-plan `submission.values[i]`, issued as numbers under the same gate.
 */
const NUMERIC_BINDING_KEYS: ReadonlySet<string> = new Set(["selectedOrder", "substitutionLocation", "minimum", "maximum"]);

/** The last path segment of a walked path, which is the key a scalar arrived under. */
function keyOf(path: string): string {
	const match = /(?:^|\.)([^.[\]]+)$/.exec(path);
	return match === null ? path : match[1];
}

/** One repair pass: the count of retyped scalars it proved and fixed, and the first it could not. */
interface RepairResult {
	count: number;
	unresolved?: { key: string; value: number | boolean };
}

/**
 * Walk a parsed binding, repairing every retyped scalar whose original can be read back from the
 * binding itself, and reporting the first one that cannot. Mutates `value` in place. The only
 * provable repair is an `arguments` entry whose `value` is a number or a boolean and whose `token`
 * equals `"--" + name + "=" + String(value)`; everything else that is not a contract number is a
 * rewrite the guard cannot restore, so it is reported instead.
 */
function repairInPlace(value: unknown, path = ""): RepairResult {
	if (Array.isArray(value)) {
		let count = 0;
		for (let index = 0; index < value.length; index += 1) {
			const result = repairInPlace(value[index], `${path}[${index}]`);
			count += result.count;
			if (result.unresolved !== undefined) return { count, unresolved: result.unresolved };
		}
		return { count };
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const isArgumentEntry =
			typeof record.name === "string" &&
			typeof record.token === "string" &&
			(typeof record.value === "number" || typeof record.value === "boolean");
		if (isArgumentEntry) {
			const name = record.name as string;
			const token = record.token as string;
			const scalar = record.value as number | boolean;
			if (token === `--${name}=${String(scalar)}`) {
				record.value = String(scalar);
				return { count: 1 };
			}
			return { count: 0, unresolved: { key: `${path}.value`, value: scalar } };
		}
		let count = 0;
		for (const [key, child] of Object.entries(record)) {
			const result = repairInPlace(child, path === "" ? key : `${path}.${key}`);
			count += result.count;
			if (result.unresolved !== undefined) return { count, unresolved: result.unresolved };
		}
		return { count };
	}
	if ((typeof value === "number" || typeof value === "boolean") && !NUMERIC_BINDING_KEYS.has(keyOf(path))) {
		return { count: 0, unresolved: { key: path, value: value as number | boolean } };
	}
	return { count: 0 };
}

/** Compact JSON with keys sorted at every level, which is the byte layout the provider issues. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const body = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",");
		return `{${body}}`;
	}
	return JSON.stringify(value) ?? "null";
}

type CaptureOutcome =
	| { kind: "none" }
	| { kind: "repaired"; count: number }
	| { kind: "block"; violation: CaptureBindingViolation };

/**
 * Repair or report one binding value. `replacement` is set only when a serialized string was parsed
 * and re-serialized; an object is repaired in place and needs no replacement. Never throws for a
 * value that is not a binding: a non-string non-object is a `not-a-string` violation.
 */
function repairOrReportOne(
	field: "collectBinding" | "collectBindings",
	index: number,
	binding: unknown,
): CaptureOutcome | { replacement: string } {
	if (typeof binding === "string") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(binding);
		} catch (error) {
			return {
				kind: "block",
				violation: {
					field,
					index,
					kind: "invalid-json",
					detail: error instanceof Error ? error.message : String(error),
				},
			};
		}
		const result = repairInPlace(parsed);
		if (result.unresolved !== undefined) {
			return {
				kind: "block",
				violation: {
					field,
					index,
					kind: "retyped-scalar-in-string",
					key: result.unresolved.key,
					value: result.unresolved.value,
				},
			};
		}
		return result.count > 0 ? { kind: "repaired", count: result.count, replacement: canonicalJson(parsed) } : { kind: "none" };
	}
	if (typeof binding === "object" && binding !== null && !Array.isArray(binding)) {
		const result = repairInPlace(binding);
		if (result.unresolved !== undefined) {
			return {
				kind: "block",
				violation: { field, index, kind: "retyped-scalar", key: result.unresolved.key, value: result.unresolved.value },
			};
		}
		return result.count > 0 ? { kind: "repaired", count: result.count } : { kind: "none" };
	}
	return { kind: "block", violation: { field, index, kind: "not-a-string", detail: typeof binding } };
}

/**
 * Repair every provable rewrite a capture call carries, or report the first one it cannot. Writes
 * the repaired input back into `input` (in place for objects, by replacement for re-serialized
 * strings). Returns `repaired` only when the input was changed and nothing remains to block.
 */
function captureOutcome(toolName: string, input: unknown): CaptureOutcome {
	if (!CAPTURE_TOOLS.includes(toolName)) return { kind: "none" };
	if (typeof input !== "object" || input === null || Array.isArray(input)) return { kind: "none" };
	const parameters = input as Record<string, unknown>;
	let repaired = 0;
	if (parameters.collectBinding !== undefined) {
		const result = repairOrReportOne("collectBinding", -1, parameters.collectBinding);
		if (result.kind === "block") return result;
		if (result.kind === "repaired") {
			repaired += result.count;
			if ("replacement" in result) parameters.collectBinding = result.replacement;
		}
	}
	const group = parameters.collectBindings;
	if (Array.isArray(group)) {
		for (let index = 0; index < group.length; index += 1) {
			const result = repairOrReportOne("collectBindings", index, group[index]);
			if (result.kind === "block") return result;
			if (result.kind === "repaired") {
				repaired += result.count;
				if ("replacement" in result) group[index] = result.replacement;
			}
		}
	}
	return repaired > 0 ? { kind: "repaired", count: repaired } : { kind: "none" };
}

/** The cause of one violation, in one sentence. */
function causeSentence(violation: CaptureBindingViolation): string {
	switch (violation.kind) {
		case "retyped-scalar":
			return (
				`carries the ${typeof violation.value} ${String(violation.value)} at "${violation.key}", where the ` +
				"contract issues a string and no token confirms the value, so the guard cannot restore it"
			);
		case "retyped-scalar-in-string":
			return (
				`carries the ${typeof violation.value} ${String(violation.value)} at "${violation.key}" inside the ` +
				"serialized binding, where the contract issues a string and no token confirms the value"
			);
		case "invalid-json":
			return (
				`is not valid JSON (${violation.detail}): the string was mangled on the way in, ` +
				"so the provider cannot match it"
			);
		case "not-a-string":
			return `arrives as a ${violation.detail} instead of a string or an object`;
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
			const outcome = captureOutcome(event.toolName, event.input);
			if (outcome.kind === "none") return;
			if (outcome.kind === "repaired") {
				debugLog(`repaired ${outcome.count} retyped scalar(s) in ${event.toolName}`);
				return;
			}
			const reason = captureBindingBlockReason(event.toolName, outcome.violation);
			debugLog(`blocked ${event.toolName}: ${reason}`);
			return { block: true, reason };
		} catch (error) {
			// Fail-open: an unobservable check must not cost the call its chance of succeeding.
			debugLog(`passed through unchanged after error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
