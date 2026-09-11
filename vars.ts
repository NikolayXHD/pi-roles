/**
 * Template engine variable layer: parsing the `template.json` config (in the
 * agent directory), computing values with shell commands, subagent values
 * and building the session view.
 *
 * Config: `vars` — variable name → fields `values` (a static list or
 * `{"shell": …}`), `initial` (a string, `{"shell": …}`, `{"env": "VAR"}`),
 * `cwd` (`"agent"` by default, `"project"`) and subagent values `@` (any
 * subagent) / `@<agent name>` (a specific one, over `@`) — strings only,
 * they replace both the machine and the computed value. An unknown key is a
 * config error. The `model` and `level` variables are implicit; declaring
 * them is an error.
 *
 * Shell contract:
 * - commands run in the platform system shell (POSIX — `sh -c`, win32 —
 *   `cmd.exe /c`) with a fixed SHELL_TIMEOUT_MS timeout;
 * - stdout is read line by line: trim, empty lines are ignored, duplicates
 *   are collapsed (order of first occurrences); for `initial` the first
 *   line is taken;
 * - a non-zero exit or a timeout means the variable has no list/value, with
 *   an error message in the report;
 * - the command environment: the process environment plus view values known
 *   at start time — implicit ones, session overrides, subagent values and a
 *   static `initial` (regardless of declaration position), computed
 *   variables declared earlier; the variable name is the env variable name;
 *   a collision with the process environment is a config error;
 * - string substitution of values into the command text is forbidden.
 *
 * The input view (implicit + session overrides) wins over a static `initial`
 * and a subagent value. Computed variables (shell/env `initial`) are
 * read-only: an input value is not applied and produces a problem. A
 * subagent value from an `@` key replaces a computed variable — for that
 * subagent's session it is not computed.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Shell command timeout, ms. */
export const SHELL_TIMEOUT_MS = 5000;

const CONFIG_FILE = "template.json";
const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Agent name: the same form pi-subagents checks (herdr-placed-run). */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Implicit variables: not declared in the config, they come in through the view. */
export const IMPLICIT_VARIABLE_NAMES = ["model", "level"] as const;

export interface ShellCommand {
	shell: string;
}

export interface EnvLookup {
	env: string;
}

export interface VariableSpec {
	/** A static value list or the shell command producing it. */
	values?: string[] | ShellCommand;
	/** Machine value: a string, a shell command or an env variable lookup. */
	initial?: string | ShellCommand | EnvLookup;
	/** `@` key: the variable value for any subagent. */
	subagentAny?: string;
	/** `@<agent name>` keys: values for specific subagents, over `@`. */
	subagentByName?: Record<string, string>;
	/** Command working directory: the agent directory (default) or the session cwd. */
	cwd?: "agent" | "project";
}

export interface VarsConfig {
	vars: Record<string, VariableSpec>;
}

export type VarsConfigLoad = VarsConfig | { problem: string };

export function isAgentName(value: string): boolean {
	return AGENT_NAME_PATTERN.test(value);
}

/**
 * A computed `initial` (shell/env) makes the variable read-only. For a
 * known subagent an `@`/`@<name>` value replaces the computed variable: it
 * is no longer computed.
 */
export function isComputedVariable(spec: VariableSpec, agentName?: string): boolean {
	if (agentName !== undefined && subagentValue(spec, agentName) !== undefined) return false;
	return typeof spec.initial === "object" && spec.initial !== null;
}

/** Subagent value of a variable: `@<name>` → `@`; no keys — `undefined`. */
export function subagentValue(spec: VariableSpec, agentName: string): string | undefined {
	const byName = spec.subagentByName?.[agentName];
	if (byName !== undefined) return byName;
	return spec.subagentAny;
}

export function isShellCommand(value: unknown): value is ShellCommand {
	return isRecord(value) && "shell" in value && typeof value.shell === "string";
}

export function isEnvLookup(value: unknown): value is EnvLookup {
	return isRecord(value) && "env" in value && typeof value.env === "string";
}

/**
 * Parse `template.json`: strict keys, an unknown key is an error. `env` is
 * the process environment for collision checks (`process.env` by default).
 */
export function parseVarsConfig(text: string, env: Record<string, string | undefined> = process.env): VarsConfigLoad {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { problem: `${CONFIG_FILE} does not parse as JSON: ${errorMessage(error)}` };
	}
	if (!isRecord(value)) return { problem: `${CONFIG_FILE} must be an object` };

	const unknown = unknownKey(value, ["vars"]);
	if (unknown) return { problem: `${CONFIG_FILE}: ${unknown}` };

	const vars: Record<string, VariableSpec> = {};
	const rawVars = value.vars;
	if (rawVars !== undefined) {
		if (!isRecord(rawVars)) return { problem: `${CONFIG_FILE}: "vars" must be an object` };
		for (const [name, rawSpec] of Object.entries(rawVars)) {
			const nameProblem = variableNameProblem(name, env);
			if (nameProblem) return { problem: nameProblem };
			const spec = parseVariableSpec(name, rawSpec);
			if ("problem" in spec) return { problem: spec.problem };
			vars[name] = spec;
		}
	}
	return { vars };
}

/** Read `template.json` from the agent directory; no file — an empty config. */
export function loadVarsConfig(agentDir: string, env?: Record<string, string | undefined>): VarsConfigLoad {
	const path = join(agentDir, CONFIG_FILE);
	if (!existsSync(path)) return { vars: {} };
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		return { problem: `${CONFIG_FILE} cannot be read: ${errorMessage(error)}` };
	}
	return parseVarsConfig(text, env ?? process.env);
}

export interface ShellExecution {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

export type ShellExecutor = (command: string, cwd: string, env: Record<string, string>) => Promise<ShellExecution>;

export interface ComputeViewOptions {
	config: VarsConfig;
	agentDir: string;
	projectDir: string;
	/**
	 * Input view: implicit `model`/`level` and session overrides. A session
	 * override wins over `initial` and a subagent value; for computed
	 * variables (shell/env) an override is impossible.
	 */
	implicit?: Record<string, string>;
	/** Agent name: `@<name>`/`@` values replace the machine and computed ones. */
	agentName?: string;
	env?: Record<string, string | undefined>;
	execute?: ShellExecutor;
}

export interface ViewReport {
	/** Values of all variables: the input view + `initial`/`@` of each declared one. */
	view: Record<string, string>;
	/**
	 * Every declared variable has a key: a value list (static or computed
	 * successfully) or `undefined` — no list.
	 */
	values: Record<string, string[] | undefined>;
	problems: string[];
	warnings: string[];
}

/**
 * View computation. Commands run in variable declaration order, no repeated
 * computations; the command environment gets the values known at start time
 * (see the header). A shell error means the variable has no list/value and
 * a message in `problems`.
 */
export async function computeView(options: ComputeViewOptions): Promise<ViewReport> {
	const envBase = stringEnv(options.env ?? process.env);
	const implicit = options.implicit ?? {};
	const agentName = options.agentName;
	const variables = options.config.vars;
	const names = Object.keys(variables);
	const execute = options.execute ?? executeShell;

	const view: Record<string, string> = { ...implicit };
	const values: Record<string, string[] | undefined> = {};
	const problems: string[] = [];
	const warnings: string[] = [];

	// Values known without computation: the input view, subagent values
	// (`@<name>` → `@`), a static `initial` and env lookups — regardless of
	// declaration position. A session override wins.
	const known: Record<string, string> = { ...implicit };
	for (const name of names) {
		const spec = variables[name];
		const subagent = agentName === undefined ? undefined : subagentValue(spec, agentName);
		if (subagent !== undefined) {
			if (Object.hasOwn(implicit, name)) continue;
			known[name] = subagent;
			view[name] = subagent;
			continue;
		}
		const initial = spec.initial;
		if (typeof initial === "string") {
			if (Object.hasOwn(implicit, name)) continue;
			known[name] = initial;
			view[name] = initial;
		} else if (isEnvLookup(initial)) {
			if (Object.hasOwn(implicit, name)) {
				problems.push(readonlyProblem(name));
				// An impossible override must not leak into the command environment:
				// the computed value overrides the input one.
				delete known[name];
				delete view[name];
			}
			known[name] = envBase[initial.env] ?? "";
			view[name] = known[name];
		} else if (isShellCommand(initial)) {
			if (Object.hasOwn(implicit, name)) {
				problems.push(readonlyProblem(name));
				delete known[name];
				delete view[name];
			}
		}
	}

	for (const name of names) {
		const spec = variables[name];
		const cwd = spec.cwd === "project" ? options.projectDir : options.agentDir;
		if (Array.isArray(spec.values)) values[name] = [...spec.values];

		const commands: Array<{ kind: "values" | "initial"; command: string }> = [];
		if (isShellCommand(spec.values)) commands.push({ kind: "values", command: spec.values.shell });
		const subagent = agentName === undefined ? undefined : subagentValue(spec, agentName);
		if (subagent === undefined && isShellCommand(spec.initial)) {
			commands.push({ kind: "initial", command: spec.initial.shell });
		}

		for (const { kind, command } of commands) {
			const commandEnv: Record<string, string> = { ...envBase, ...known };
			const result = await execute(command, cwd, commandEnv);
			if (result.error) {
				problems.push(shellProblem(name, kind, `command did not run: ${result.error}`));
				if (kind === "initial") view[name] = "";
				continue;
			}
			if (result.code !== 0) {
				const stderr = result.stderr.trim();
				problems.push(
					shellProblem(name, kind, `command exited with code ${result.code}${stderr ? `: ${stderr}` : ""}`),
				);
				if (kind === "initial") view[name] = "";
				continue;
			}
			if (kind === "values") {
				values[name] = parseShellLines(result.stdout);
			} else {
				const value = firstShellLine(result.stdout);
				view[name] = value;
				known[name] = value;
			}
		}

		warnings.push(...laterComputedReferences(name, spec, names, variables, agentName));
	}

	// Every declared variable is present in the view and in values: no value —
	// an empty string, no list — `undefined`.
	for (const name of names) {
		if (!Object.hasOwn(view, name)) view[name] = "";
		if (!Object.hasOwn(values, name)) values[name] = undefined;
	}

	return { view, values, problems, warnings };
}

/**
 * Platform system shell: POSIX — `sh -c`, win32 — `cmd.exe /c`. The timeout
 * is fixed. On POSIX the command runs in its own process group, and the
 * whole group is killed on timeout — background descendants of the command
 * do not survive the timeout. On win32 only the shell itself is killed (a
 * platform limitation): detached descendants may survive the timeout.
 */
async function executeShell(command: string, cwd: string, env: Record<string, string>): Promise<ShellExecution> {
	const [shell, flag] = process.platform === "win32" ? ["cmd.exe", "/c"] : ["sh", "-c"];
	const detached = process.platform !== "win32";
	return new Promise((resolve) => {
		const child = spawn(shell, [flag, command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: ShellExecution): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			killProcessTree(child);
			finish({ code: null, stdout, stderr, error: `timeout ${SHELL_TIMEOUT_MS} ms` });
		}, SHELL_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => finish({ code: null, stdout, stderr, error: errorMessage(error) }));
		child.on("close", (code) => finish({ code, stdout, stderr }));
	});
}

/** Kill the command: on POSIX the whole process group, otherwise the shell itself. */
function killProcessTree(child: ChildProcess): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// The group is gone already — kill the shell itself below.
		}
	}
	child.kill("SIGKILL");
}

/** stdout line by line: trim, empty ignored, duplicates collapsed. */
export function parseShellLines(stdout: string): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const value = line.trim();
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		lines.push(value);
	}
	return lines;
}

export function firstShellLine(stdout: string): string {
	return parseShellLines(stdout)[0] ?? "";
}

/**
 * Canonical serialization: stable (ordered) key order. For view
 * comparison.
 */
export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
		return sorted;
	}
	return value;
}

function parseVariableSpec(name: string, raw: unknown): VariableSpec | { problem: string } {
	if (!isRecord(raw)) return { problem: `${CONFIG_FILE}: variable "${name}" must be an object` };

	const spec: VariableSpec = {};
	const subagentByName: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "values") {
			if (Array.isArray(value)) {
				if (!value.every((item) => typeof item === "string")) {
					return { problem: `${CONFIG_FILE}: variable "${name}": "values" must be a list of strings` };
				}
				spec.values = [...value] as string[];
			} else if (isShellCommand(value) && Object.keys(value).length === 1) {
				spec.values = value;
			} else {
				return {
					problem: `${CONFIG_FILE}: variable "${name}": "values" must be a list of strings or {"shell": …}`,
				};
			}
			continue;
		}
		if (key === "initial") {
			if (typeof value === "string") {
				spec.initial = value;
			} else if (isShellCommand(value) && Object.keys(value).length === 1) {
				spec.initial = value;
			} else if (isEnvLookup(value) && Object.keys(value).length === 1) {
				spec.initial = value;
			} else {
				return {
					problem: `${CONFIG_FILE}: variable "${name}": "initial" must be a string, {"shell": …} or {"env": "…"}`,
				};
			}
			continue;
		}
		if (key === "cwd") {
			if (value !== "agent" && value !== "project") {
				return { problem: `${CONFIG_FILE}: variable "${name}": "cwd" must be "agent" or "project"` };
			}
			spec.cwd = value;
			continue;
		}
		if (key === "@") {
			if (typeof value !== "string") {
				return { problem: `${CONFIG_FILE}: variable "${name}": "@" must be a string` };
			}
			spec.subagentAny = value;
			continue;
		}
		if (key.startsWith("@")) {
			const agentName = key.slice(1);
			if (!isAgentName(agentName)) {
				return { problem: `${CONFIG_FILE}: variable "${name}": key "${key}": invalid agent name` };
			}
			if (typeof value !== "string") {
				return { problem: `${CONFIG_FILE}: variable "${name}": key "${key}" must be a string` };
			}
			subagentByName[agentName] = value;
			continue;
		}
		return { problem: `${CONFIG_FILE}: variable "${name}": unknown key "${key}"` };
	}
	if (Object.keys(subagentByName).length > 0) spec.subagentByName = subagentByName;
	return spec;
}

function variableNameProblem(name: string, env: Record<string, string | undefined>): string | null {
	if (!VARIABLE_NAME_PATTERN.test(name)) {
		return `${CONFIG_FILE}: variable name "${name}" is not an identifier`;
	}
	if ((IMPLICIT_VARIABLE_NAMES as readonly string[]).includes(name)) {
		return `${CONFIG_FILE}: variable "${name}" is implicit and cannot be declared`;
	}
	if (env[name] !== undefined) {
		return `${CONFIG_FILE}: variable "${name}" collides with a process environment variable`;
	}
	return null;
}

/**
 * Lint warning: the command mentions the name of a computed (shell `initial`)
 * variable declared later — its value does not get into the command
 * environment. A subagent value (`@`/`@<name>`) replaces a computed
 * variable — for that session it is known in advance and present in the
 * environment, so there is no warning. Env lookups are not included: their
 * value is known without computation and is in the environment regardless
 * of declaration position.
 */
function laterComputedReferences(
	name: string,
	spec: VariableSpec,
	names: string[],
	variables: Record<string, VariableSpec>,
	agentName: string | undefined,
): string[] {
	const position = names.indexOf(name);
	const commands: string[] = [];
	if (isShellCommand(spec.values)) commands.push(spec.values.shell);
	if (isShellCommand(spec.initial) && isComputedVariable(spec, agentName)) commands.push(spec.initial.shell);
	if (commands.length === 0) return [];

	const warnings: string[] = [];
	const seen = new Set<string>();
	for (const command of commands) {
		const pattern = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
		for (const match of command.matchAll(pattern)) {
			const referenced = match[1];
			if (referenced === name || seen.has(referenced)) continue;
			const referencedSpec = variables[referenced];
			const later = names.indexOf(referenced) > position;
			const computed =
				referencedSpec !== undefined &&
				isShellCommand(referencedSpec.initial) &&
				isComputedVariable(referencedSpec, agentName);
			if (!later || !computed) continue;
			seen.add(referenced);
			warnings.push(
				`variable "${name}": the command mentions variable "${referenced}" declared later — its value will not be in the environment`,
			);
		}
	}
	return warnings;
}

function shellProblem(name: string, kind: "values" | "initial", detail: string): string {
	const what = kind === "values" ? "values list" : "initial value";
	return `${CONFIG_FILE}: variable "${name}": ${what}: ${detail}`;
}

function readonlyProblem(name: string): string {
	return `variable "${name}": input value ignored — variable is computed, read-only`;
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

function unknownKey(value: Record<string, unknown>, allowed: string[]): string | null {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) return `unknown key "${key}"`;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
