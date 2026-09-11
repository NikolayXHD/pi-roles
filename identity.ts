/**
 * Identity channels of a child session.
 *
 * The primary marker is the `<active_agent name="…"/>` tag in the system
 * prompt (a pi-subagents convention, not a published contract; writers are
 * `child-launch.js` and `herdr-pi-bridge.js`). The fallback is the session
 * name: `agent: <task excerpt>` (or just `agent`) from
 * `deriveChildSessionName`, or the intercom form
 * `subagent-<agent>-<runId>[-N]` from `resolveSubagentIntercomTarget`
 * (runId is a uuid; both parts are sanitized to `[a-z0-9_-]`). The literal
 * `agent` is not an agent name: it is a sanitizer/session-name stub, "name
 * unknown". Name parsing is heuristic: the fallback channel only refines
 * the primary one.
 */

import { isAgentName } from "./vars.ts";

/** The tag: a quoted attribute; names with `&quot;` are not produced by writers. */
const ACTIVE_AGENT_PATTERN = /<active_agent\s+name\s*=\s*"([^"]*)"\s*\/>/u;
/** Intercom form: `subagent-<agent>-<uuid>` with an optional step index. */
const INTERCOM_PATTERN =
	/^subagent-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/u;

/** Name stub: the intercom sanitizer and a session name without an excerpt. */
const UNNAMED = "agent";

function validName(value: string | undefined): value is string {
	return value !== undefined && value !== UNNAMED && isAgentName(value);
}

/** Agent name from the system prompt: the first `<active_agent name="…"/>` tag. */
export function agentNameFromPrompt(prompt: string): string | undefined {
	const match = ACTIVE_AGENT_PATTERN.exec(prompt);
	if (!match) return undefined;
	const name = match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
	return isAgentName(name) ? name : undefined;
}

/** Whether the text has an `<active_agent name="…"/>` tag (including in a derived prompt). */
export function hasActiveAgentTag(text: string): boolean {
	return ACTIVE_AGENT_PATTERN.test(text);
}

/**
 * Agent name from the session name. Understands an exact name,
 * `agent: <excerpt>` and the intercom form `subagent-<agent>-<uuid>[-N]`;
 * the literal `agent` and other forms give `undefined` (agent unknown).
 */
export function agentNameFromSessionName(name: string | undefined): string | undefined {
	const trimmed = name?.trim();
	if (!trimmed) return undefined;
	// The intercom form is recognized before the exact name: an exact name would take it whole.
	const intercom = INTERCOM_PATTERN.exec(trimmed);
	if (intercom && validName(intercom[1])) return intercom[1];
	if (validName(trimmed)) return trimmed;
	const derived = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):\s/u.exec(trimmed);
	return derived && validName(derived[1]) ? derived[1] : undefined;
}
