// gentle-review-controller-input-repair — local Pi extension, workaround for a `gentle_review`
// call whose `input` arrived as a JSON object where the controller requires a JSON string.
// Not an upstream fix: delete this file once it lands.
//
// Why: the review controller reads its `input` argument as a serialized object string for every
// operation except START and ASSESS (`parseReviewControllerParameters`, extensions/gentle-ai.ts:5567
// in the installed release, which serializes the object form only for START and ASSESS; the
// upstream checkout at :5678 also accepts the object form for ANSWER_CONSENT). A provider whose
// tool-argument serialization emits the object form therefore makes the call fail with "Review
// controller input must be a string", and the review lineage stalls on `status`, `answer-consent`
// and `acknowledge-approved` without the rejection ever naming the cause.
//
// What: a `tool_call` handler that re-serializes `event.input.input` into its JSON string, in
// place, but only for an operation that requires the string form and only when the object is
// provably lossless. The lossless gate mirrors the controller's own `serializeReviewJsonArgument`
// check by check (extensions/gentle-ai.ts:5484 in the installed release, :5595 in the upstream
// checkout): plain objects and plain arrays only, own string keys only, enumerable data
// properties only, leaves limited to string, boolean, null and finite numbers that are not -0, no
// cycle and no proxy. The bytes written are therefore the bytes the controller would have written.
//
// A payload that fails any of those checks is left untouched, so the controller keeps rejecting it
// and still names the cause. START and ASSESS are left alone: their object form is already
// accepted, so repairing it would rewrite a call that works.
//
// Scope: `gentle_review` only, and only the `input` slot of its parameters. The call is never
// blocked, and no field inside the payload is added, removed or rewritten: the payload is
// serialized as it stands.
//
// Fail-open: every path is wrapped, so an internal error passes the call through unchanged and
// stays silent, like gentle-review-start-repair.ts and gentle-review-capture-guard.ts.
//
// Debug: `GENTLE_AI_DEBUG_CONTROLLER_INPUT=1` writes one stderr line per repair.
// Install: it ships inside the `pi-minimax-gs` package and is registered in its `package.json`
// (`pi.extensions`), so Pi loads `extensions/gentle-review-controller-input-repair.ts` from this
// package at startup; `/reload` activates it in a session that is already open.

import { isProxy } from "node:util/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The only tool this extension touches. */
const REVIEW_TOOL = "gentle_review";

/** The two operations whose object form the controller already accepts, and never repairs. */
const OBJECT_INPUT_OPERATIONS: readonly string[] = ["start", "assess"];

const DEBUG_ENV = "GENTLE_AI_DEBUG_CONTROLLER_INPUT";

function debugLog(message: string): void {
	if (process.env[DEBUG_ENV] !== "1") return;
	try {
		process.stderr.write(`[gentle-review-controller-input-repair] ${message}\n`);
	} catch {
		// Observability must never affect the call.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The controller's own lossless contract, mirrored check by check from
 * `serializeReviewJsonArgument` (extensions/gentle-ai.ts:5484 in the installed release, :5595 in
 * the upstream checkout). A payload this accepts is one the controller serializes to the very same
 * bytes; a payload it rejects is one the controller rejects too, with its cause named.
 */
export function isProvablyLosslessJsonPayload(value: unknown): boolean {
	if (isProxy(value) || !isRecord(value)) return false;
	const ancestors = new Set<object>();
	const check = (item: unknown): boolean => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return true;
		if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0);
		if (typeof item !== "object" || item === null || isProxy(item) || ancestors.has(item)) return false;
		const array = Array.isArray(item);
		if (array && Object.getPrototypeOf(item) !== Array.prototype) return false;
		if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
		ancestors.add(item);
		const keys = Reflect.ownKeys(item);
		if (array && keys.length !== item.length + 1) {
			ancestors.delete(item);
			return false;
		}
		for (const key of keys) {
			if (array && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (descriptor === undefined) {
				ancestors.delete(item);
				return false;
			}
			if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) {
				ancestors.delete(item);
				return false;
			}
			if (!check(descriptor.value)) {
				ancestors.delete(item);
				return false;
			}
		}
		ancestors.delete(item);
		return true;
	};
	return check(value);
}

/**
 * The JSON string the controller would read for this payload, or undefined when the payload is not
 * an object the controller would accept. An empty object carries no content, so it is left alone
 * as well: re-serializing it would turn "no input" into "an empty input".
 */
export function serializeControllerInputPayload(value: unknown): string | undefined {
	if (!isProvablyLosslessJsonPayload(value)) return undefined;
	if (Reflect.ownKeys(value as object).length === 0) return undefined;
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? serialized : undefined;
	} catch {
		return undefined;
	}
}

export default function gentleReviewControllerInputRepair(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		try {
			if (event.toolName !== REVIEW_TOOL) return;
			const parameters = event.input as unknown;
			if (!isRecord(parameters)) return;
			const operation = parameters.operation;
			if (typeof operation !== "string") return;
			if (OBJECT_INPUT_OPERATIONS.includes(operation)) return;
			const payload = parameters.input;
			if (!isRecord(payload)) return;
			const serialized = serializeControllerInputPayload(payload);
			if (serialized === undefined) return;
			parameters.input = serialized;
			debugLog(`re-serialized the input object for operation=${operation} bytes=${Buffer.byteLength(serialized, "utf8")}`);
		} catch {
			// Fail-open and silent: the controller reports its own rejection for the original call.
		}
	});
}
