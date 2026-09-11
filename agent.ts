/**
 * Agent file: extracting actual `model`/`level` from the YAML header —
 * the seam between the engine stages (`renderAgentHeader`/`renderAgentBody`)
 * and the full-file render.
 *
 * The agent file header is frontmatter in pi's convention. Child fields:
 * `model` (a `provider/modelId` string, optional `:level` suffix) and
 * `thinking` (thinking level, `false` means `off`). Value priority follows
 * the pi-subagents consumer (`resolveEffectiveSubagentModel`/
 * `resolveEffectiveThinking`): explicit spawn parameter (full model, level
 * suffix) → YAML header → session default. A level suffix in the chosen
 * model wins over `thinking`; unknown levels and non-string `thinking` are
 * silently ignored by the consumer — and by us. A `model` of the wrong type
 * is a parse failure (the file render fails, the target file is not rewritten).
 */

import { type PartialResolver, THINKING_LEVELS, renderAgentBody, renderAgentHeader } from "./render.ts";

/** Frontmatter parsing: text (with delimiters) to an object. */
export type HeaderParser = (text: string) => Record<string, unknown>;

export interface AgentHeaderFacts {
	model?: string;
	level?: string;
}

/** Known level suffix in a model string: `p/q:high` → `p/q` + `high`. */
export function splitThinkingSuffix(model: string): { model: string; suffix?: string } {
	const colon = model.lastIndexOf(":");
	if (colon <= 0) return { model };
	const suffix = model.slice(colon + 1);
	if (!(THINKING_LEVELS as readonly string[]).includes(suffix)) return { model };
	return { model: model.slice(0, colon), suffix };
}

/**
 * Actual `model`/`level` from the parsed header. `thinking: false` means
 * `off`; `true`, non-string and unknown levels mean "no level set" (as in
 * `resolveEffectiveThinking`). A model suffix wins over `thinking`.
 */
export function agentHeaderFacts(parsed: Record<string, unknown>): AgentHeaderFacts {
	const facts: AgentHeaderFacts = {};
	const rawModel = parsed.model;
	if (rawModel !== undefined) {
		if (typeof rawModel !== "string" || rawModel.trim() === "") {
			throw new Error("header model must be a non-empty string");
		}
		const split = splitThinkingSuffix(rawModel);
		facts.model = split.model;
		if (split.suffix !== undefined) facts.level = split.suffix;
	}
	if (facts.level === undefined) {
		const thinking = parsed.thinking;
		if (thinking === false) {
			facts.level = "off";
		} else if (typeof thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(thinking)) {
			facts.level = thinking;
		}
	}
	return facts;
}

export interface AgentFilePreliminary {
	model: string;
	level: string;
	/** Explicit spawn parameter: the model overrides the header (as in pi-subagents). */
	explicitModel?: boolean;
	/** Explicit `:level` suffix of the spawn parameter: the level overrides the header. */
	explicitLevel?: boolean;
}

export interface AgentFileRenderOptions {
	/** Agent name of the file (for the `@` qualifier and view keys). */
	agentName: string;
	/** Parent session variable values — regular references. */
	parentView: Record<string, string>;
	/** `@`-variable values of the future child; `model`/`level` are preliminary. */
	subagentView: Record<string, string>;
	variables: Record<string, string[] | undefined>;
	/** Include resolver: names are resolved on disk at render time. */
	partials: PartialResolver;
	/** Collector of lint warnings of the include texts read in this render. */
	warnings?: string[];
	/**
	 * Preliminary `model`/`level`: spawn parameters over the applied session
	 * values, or the session default (spawn-less re-render). The `explicit*`
	 * flags distinguish a parameter from a default: an explicit parameter is
	 * not overridden by the header.
	 */
	preliminary: AgentFilePreliminary;
	parseHeader: HeaderParser;
}

export interface AgentFileRender {
	/** Full file text: the header at its fixpoint plus the body. */
	text: string;
	model: string;
	level: string;
}

/**
 * Full agent file render: the header iterated to a fixpoint, the body with
 * actual `model`/`level`. The same code serves spawn and spawn-less
 * re-render — only `preliminary` differs.
 */
export function renderAgentFile(source: string, options: AgentFileRenderOptions): AgentFileRender {
	const context = {
		agentName: options.agentName,
		parentView: options.parentView,
		subagentView: options.subagentView,
		variables: options.variables,
		partials: options.partials,
		warnings: options.warnings,
	};
	const extract = (header: string): { model: string; level: string } => {
		const facts = agentHeaderFacts(options.parseHeader(header));
		return {
			model: options.preliminary.explicitModel ? options.preliminary.model : facts.model ?? options.preliminary.model,
			level: options.preliminary.explicitLevel ? options.preliminary.level : facts.level ?? options.preliminary.level,
		};
	};
	const fixpoint = renderAgentHeader(source, context, extract);
	const body = renderAgentBody(source, {
		...context,
		subagentView: { ...options.subagentView, model: fixpoint.model, level: fixpoint.level },
	});
	return { text: fixpoint.header + body, model: fixpoint.model, level: fixpoint.level };
}
