/**
 * Live check of derived text: explicit session `systemPrompt`/
 * `appendSystemPrompt` (as in pi-subagents children) are not rewritten by
 * our target files. Expectation — `preamble`/`addendum` carry the derived
 * strings, `DERIVED TEXT SMOKE OK`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, PI } from "./sdk.mjs";

const pi = await import(PI);

const root = mkdtempSync(join(tmpdir(), "pi-template-derived-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(projectDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "template.json"), JSON.stringify({ vars: { who: { initial: "world" } } }));
writeFileSync(join(agentDir, "SYSTEM.md.template"), "System {{who}}");
writeFileSync(join(agentDir, "APPEND_SYSTEM.md.template"), "Extra {{who}}");

const settingsManager = pi.SettingsManager.create(projectDir, agentDir);
const modelRuntime = await pi.ModelRuntime.create({
	authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
	modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
});
modelRuntime.registerProvider("fake", {
	name: "Fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fake",
	models: [{ id: "fake", name: "Fake", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
});
const model = modelRuntime.getModel("fake", "fake");
const loader = new pi.DefaultResourceLoader({
	cwd: projectDir, agentDir, settingsManager,
	additionalExtensionPaths: [EXT], noExtensions: true, noThemes: true,
	systemPrompt: "DERIVED CHILD PROMPT", appendSystemPrompt: ["DERIVED EXTRA"],
});
await loader.reload();
const result = await pi.createAgentSession({
	cwd: projectDir, agentDir, modelRuntime, model, thinkingLevel: "low",
	resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(projectDir), settingsManager,
});
await result.session.bindExtensions({});
try { await result.session.prompt("hello"); } catch {}
await result.session.waitForIdle();
for (const message of result.session.messages) {
	if (message.role !== "system") continue;
	const sections = message.sections ?? {};
	console.log("preamble:", JSON.stringify(String(sections.preamble ?? "").slice(0, 40)));
	console.log("addendum:", JSON.stringify(String(sections.addendum ?? "").slice(0, 40)));
}
result.session.dispose();
rmSync(root, { recursive: true, force: true });
console.log("DERIVED TEXT SMOKE OK");
