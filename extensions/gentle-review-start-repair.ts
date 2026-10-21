// gentle-review-start-repair — local Pi extension, workaround for
// Gentleman-Programming/gentle-shell#2280. Not an upstream fix: delete this file once it lands.
//
// Why: an orchestrator whose tool-argument serialization is buggy can deliver a `gentle_review`
// START `input` where `lenses` is a string (or carries duplicate / non-canonical names), where
// `lensesReason` has a newline or more than 500 bytes, or where `committedOnly` is a string
// ("true"). The controller then rejects the call before any authority exists: `lenses-invalid`
// (`validateNativeStartLensSelection`, extensions/gentle-ai.ts:6495) or `committed-only-required`
// (gentle-ai.ts:9205-9207).
//
// What: a `tool_call` handler restoring a relocated parameter envelope and repairing only those three
// fields, in place, before the tool runs.
// `event.input` is mutable and Pi performs no re-validation after mutation (`ToolCallEvent`, pi
// dist/core/extensions/types.d.ts). A `tool_call` handler failure blocks the tool, so every path
// below is caught and falls back to passing the call through unchanged.
//
// Scope: `gentle_review` + `operation: "start"` + a parsed `input.mode === "ordinary"` only.
// `operation`, `mode`, `baseRef`, `policyPath`, `focus`, `untrackedScope`,
// `expectedUntrackedInventory`, `intendedUntracked` and a provider-issued `submission` binding are
// never rewritten inside a parsed `input`. A buggy serializer has also been observed to relocate the
// tool's own parameters inside `input`, so the handler first restores that envelope (see
// `repairEnvelope`) and only then runs the repair above. A payload whose fields are already valid
// passes through byte-identical.
// Debug: `GENTLE_AI_DEBUG_LENS_PATCH=1` prints every repair (or swallowed failure) to stderr.
// Install: it ships inside the `pi-warden-gs` package and is registered in its `package.json`
// (`pi.extensions`), so Pi loads `extensions/gentle-review-start-repair.ts` from this package at startup; `/reload`
// activates it in a session that is already open. No orchestrator-side change is needed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** NATIVE_START_LENSES — extensions/gentle-ai.ts:6485. */
export const NATIVE_START_LENSES: readonly string[] = ["review-risk", "review-resilience", "review-readability", "review-reliability"];

/** NATIVE_START_LENS_REASON_MAX — extensions/gentle-ai.ts:6486. */
const LENS_REASON_MAX_BYTES = 500;

/** Used only when a lens selection exists but its reason does not. */
const DEFAULT_LENSES_REASON = "lens selection repaired by the local gentle-review-start-repair extension";

function debugLog(message: string): void {
	if (process.env.GENTLE_AI_DEBUG_LENS_PATCH !== "1") return;
	try {
		process.stderr.write(`[gentle-review-start-repair] ${message}\n`);
	} catch {
		// Observability must never affect the call.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonicalize one token (`"risk"`, `"review-risk"`, `" Review_Risk "`) or return undefined. */function canonicalLens(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const token = value.trim().toLowerCase().replace(/^review[-_ ]/, "");
	if (token.length === 0) return undefined;
	const canonical = `review-${token}`;
	return NATIVE_START_LENSES.includes(canonical) ? canonical : undefined;
}

/**
 * Accepts what a mangled call can carry: an array, a JSON-encoded array string, or a
 * delimiter-separated string. Returns canonical names in NATIVE_START_LENSES order, deduplicated.
 */
export function canonicalLenses(value: unknown): string[] {
	const candidates: unknown[] = [];
	if (Array.isArray(value)) {
		candidates.push(...value);
	} else if (typeof value === "string") {
		const text = value.trim();
		if (text.length === 0) return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (Array.isArray(parsed)) candidates.push(...parsed);
		else candidates.push(...text.split(/[,;|]+|\s+/));
	} else {
		return [];
	}
	const chosen: string[] = [];
	for (const candidate of candidates) {
		const lens = canonicalLens(candidate);
		if (lens !== undefined && !chosen.includes(lens)) chosen.push(lens);
	}
	return NATIVE_START_LENSES.filter((lens) => chosen.includes(lens));
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = "";
	for (const character of text) {
		if (Buffer.byteLength(truncated + character, "utf8") > maxBytes) break;
		truncated += character;
	}
	return truncated.trim();
}

/** Single line, non-empty, within the controller's byte cap — or undefined when unusable. */
export function repairLensesReason(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const singleLine = value
		.replace(/[\r\n\t\f\v]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (singleLine.length === 0) return undefined;
	return truncateToUtf8Bytes(singleLine, LENS_REASON_MAX_BYTES);
}

/**
 * Repaired lens fields, or undefined when they are already valid. The "both or neither" contract
 * holds: a selection is filled in only when the orchestrator declared one that arrived unusable,
 * or stated a reason without one; with neither field present the provider's tier default stands.
 */
export function repairStartInput(raw: Record<string, unknown>): Record<string, unknown> | undefined {
	const declaredLenses = raw.lenses;
	const reason = repairLensesReason(raw.lensesReason);
	const usable = canonicalLenses(declaredLenses);
	const lenses =
		usable.length > 0
			? usable
			: declaredLenses !== undefined || reason !== undefined
				? [...NATIVE_START_LENSES]
				: undefined;
	if (lenses === undefined) return undefined;
	const lensesReason = reason ?? DEFAULT_LENSES_REASON;
	const lensesUnchanged =
		Array.isArray(declaredLenses) &&
		declaredLenses.length === lenses.length &&
		declaredLenses.every((value, index) => value === lenses[index]);
	if (lensesUnchanged && raw.lensesReason === lensesReason) return undefined;
	return { lenses, lensesReason };
}

/**
 * `committedOnly` is meaningful only as the boolean `true`; the contract rejects a standalone
 * false, and a stringified "true" fails `committedOnly !== true`. Returns true to set it, "delete"
 * for the falsy spellings (equivalent to the provider's own default), undefined to leave it alone.
 */
export function repairCommittedOnly(value: unknown): true | "delete" | undefined {
	if (value === true) return undefined;
	if (value === false) return "delete";
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		if (text === "true" || text === "1") return true;
		if (text === "false" || text === "0") return "delete";
		return undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value === 1) return true;
		if (value === 0) return "delete";
	}
	return undefined;
}

/** Repaired ordinary-START object, or undefined when nothing had to change. */
export function repairOrdinaryStartInput(raw: Record<string, unknown>): Record<string, unknown> | undefined {
	const lensFields = repairStartInput(raw);
	const committedOnly = repairCommittedOnly(raw.committedOnly);
	if (lensFields === undefined && committedOnly === undefined) return undefined;
	const repaired: Record<string, unknown> = { ...raw, ...(lensFields ?? {}) };
	if (committedOnly === "delete") delete repaired.committedOnly;
	else if (committedOnly === true) repaired.committedOnly = true;
	return repaired;
}

/** Parses `input` whether it arrived as an object or as a serialized object string. */
function parseInputObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string") return isRecord(value) ? value : undefined;
	const text = value.trim();
	if (text.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isRecord(parsed) ? parsed : undefined;
}

/** The tool's own parameters, which a buggy serializer has been observed to relocate inside `input`. */
const ENVELOPE_KEYS: readonly string[] = ["operation", "input", "baseRef", "committedOnly", "idempotencyKey", "workspaceRoot"];

/**
 * Moves recognised tool parameters that arrived nested inside `input` back to the top level, but only
 * where the top-level slot is empty. Without this the handler never reaches its own repair, because
 * `parameters.operation` is undefined, and the controller answers "operation: must have required
 * properties operation" without ever seeing the call.
 *
 * A top level already carrying a string `operation` is the signature that nothing was relocated, so
 * that call is left byte-identical. The relocated wrapper is the other shape: its own `input` slot
 * holds the envelope rather than the START payload, so the nested `input` replaces it and the
 * payload reaches the repair below.
 */
export function repairEnvelope(parameters: Record<string, unknown>): Record<string, unknown> | undefined {
	if (typeof parameters.operation === "string") return undefined;
	const nested = parseInputObject(parameters.input);
	if (nested === undefined) return undefined;
	let changed = false;
	for (const key of ENVELOPE_KEYS) {
		if (key === "input") {
			if (nested.input === undefined) continue;
			parameters.input = nested.input;
			changed = true;
			continue;
		}
		if (parameters[key] !== undefined) continue;
		const value = nested[key];
		if (value === undefined) continue;
		if (typeof value !== "string" && typeof value !== "boolean") continue;
		parameters[key] = value;
		changed = true;
	}
	return changed ? parameters : undefined;
}

export default function gentleReviewLensRepair(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		try {
			if (event.toolName !== "gentle_review") return;
			const parameters = event.input as unknown;
			if (!isRecord(parameters)) return;
			const hoisted = repairEnvelope(parameters);
			if (hoisted !== undefined) debugLog(`hoisted relocated tool parameters back, operation=${JSON.stringify(parameters.operation)}`);
			if (parameters.operation !== "start") return;
			const parsed = parseInputObject(parameters.input);
			if (parsed === undefined) return;
			if (parsed.mode !== "ordinary" || "submission" in parsed || parsed.focus !== undefined) return;
			const repaired = repairOrdinaryStartInput(parsed);
			if (repaired === undefined) return;
			parameters.input = JSON.stringify(repaired);
			debugLog(
				`repaired START input: lenses=${JSON.stringify(repaired.lenses)} reasonBytes=${Buffer.byteLength(String(repaired.lensesReason), "utf8")} committedOnly=${JSON.stringify(repaired.committedOnly)}`,
			);
		} catch (error) {
			// Fail-open: the controller reports its own rejection for the original call.
			debugLog(`passed through unchanged after error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
