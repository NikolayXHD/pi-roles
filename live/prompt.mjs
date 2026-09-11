/**
 * Live check of context delivery into the system prompt: turn sections
 * (contextFiles) carry the rendered text. Expectation — the output of
 * `system sections:` and `contextFiles section:` shows target file text,
 * with no raw tags.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, PI } from "./sdk.mjs";

const pi = await import(PI);

const root = mkdtempSync(join(tmpdir(), "pi-template-live-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const projectDir = join(root, "project");
mkdirSync(join(agentDir, "skills", "x"), { recursive: true });
mkdirSync(join(agentDir, "roles"), { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });
writeFileSync(join(agentDir, "template.json"), JSON.stringify({ vars: { who: { initial: "world" } } }));
writeFileSync(join(agentDir, "roles", "a.md"), "Role {{who}}", { flag: "w" });
writeFileSync(join(agentDir, "skills", "x", "SKILL.md.template"), "---\ndescription: Skill {{who}}\n---\nbody {{who}}");
writeFileSync(join(projectDir, "AGENTS.md.template"), "Project {{who}}\n{{> roles/a.md}}");
writeFileSync(join(projectDir, ".pi", "SYSTEM.md.template"), "System {{who}}");

const settingsManager = pi.SettingsManager.create(projectDir, agentDir);
const modelRuntime = await pi.ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
	modelsStorePath: join(agentDir, "models-store.json"),
	allowModelNetwork: false,
});
modelRuntime.registerProvider("fake", {
	name: "Fake",
	baseUrl: "http://127.0.0.1:1",
	api: "openai-completions",
	apiKey: "fake",
	models: [
		{ id: "fake", name: "Fake", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
	],
});
const model = modelRuntime.getModel("fake", "fake");
if (!model) throw new Error("test model not created");

const loader = new pi.DefaultResourceLoader({
	cwd: projectDir,
	agentDir,
	settingsManager,
	additionalExtensionPaths: [EXT],
	noExtensions: true,
	noThemes: true,
});
await loader.reload();

const result = await pi.createAgentSession({
	cwd: projectDir,
	agentDir,
	modelRuntime,
	model,
	thinkingLevel: "low",
	resourceLoader: loader,
	sessionManager: pi.SessionManager.inMemory(projectDir),
	settingsManager,
});

await result.session.bindExtensions({});
const errors = result.extensionsResult.errors ?? [];
console.log("extension errors:", JSON.stringify(errors, null, 1));
console.log("loaded extensions:", result.extensionsResult.extensions.map((e) => e.path));

const projectTarget = join(projectDir, "AGENTS.md");
const skillTarget = join(agentDir, "skills", "x", "SKILL.md");
const systemTarget = join(projectDir, ".pi", "SYSTEM.md");
console.log("project target exists:", existsSync(projectTarget));
if (existsSync(projectTarget)) console.log("project target:", JSON.stringify(readFileSync(projectTarget, "utf-8")));
console.log("skill target exists:", existsSync(skillTarget));
if (existsSync(skillTarget)) console.log("skill target:", JSON.stringify(readFileSync(skillTarget, "utf-8")));
console.log("system target exists:", existsSync(systemTarget));
if (existsSync(systemTarget)) console.log("system target:", JSON.stringify(readFileSync(systemTarget, "utf-8")));


result.session.dispose();
rmSync(root, { recursive: true, force: true });
try {
	await result.session.prompt("hello");
} catch (error) {
	console.log("prompt error:", String(error.message).slice(0, 120));
}
await result.session.waitForIdle();
for (const message of result.session.messages) {
	if (message.role !== "system") continue;
	const sections = message.sections ?? {};
	console.log("system sections:", Object.keys(sections).join(","));
	if (sections.contextFiles) console.log("contextFiles section:", String(sections.contextFiles).slice(0, 160).replace(/\n/g, " | "));
}
console.log("SMOKE OK");
