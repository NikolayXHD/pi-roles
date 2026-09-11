/**
 * Live check of the first run: no target files when pi loaded, sections are
 * added (not replaced). Expectation — the same fresh texts and
 * `DELIVERY SMOKE OK`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, PI } from "./sdk.mjs";

const pi = await import(PI);

const root = mkdtempSync(join(tmpdir(), "pi-template-delivery-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "skills", "x"), { recursive: true });
mkdirSync(join(agentDir, "roles"), { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });
writeFileSync(join(agentDir, "template.json"), JSON.stringify({ vars: { who: { initial: "world" } } }));
writeFileSync(join(agentDir, "roles", "a.md"), "Role {{who}}");
writeFileSync(join(agentDir, "skills", "x", "SKILL.md.template"), "---\ndescription: Skill {{who}}\n---\nbody {{who}}");
writeFileSync(join(agentDir, "SYSTEM.md.template"), "System {{who}}");
writeFileSync(join(agentDir, "APPEND_SYSTEM.md.template"), "Extra {{who}}");
writeFileSync(join(projectDir, "AGENTS.md.template"), "Project {{who}}\n{{> roles/a.md}}");

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
	models: [{ id: "fake", name: "Fake", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
});
const model = modelRuntime.getModel("fake", "fake");
const loader = new pi.DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager, additionalExtensionPaths: [EXT], noExtensions: true, noThemes: true });
await loader.reload();
console.log("customPrompt at load:", JSON.stringify(loader.getSystemPrompt()));
console.log("contextFiles at load:", loader.getAgentsFiles().agentsFiles.length, "skills at load:", loader.getSkills().skills.length);
const result = await pi.createAgentSession({
	cwd: projectDir, agentDir, modelRuntime, model, thinkingLevel: "low",
	resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(projectDir), settingsManager,
});
await result.session.bindExtensions({});
try { await result.session.prompt("hello"); } catch (error) { console.log("prompt error:", String(error.message).slice(0, 80)); }
await result.session.waitForIdle();
for (const message of result.session.messages) {
	if (message.role !== "system") continue;
	const sections = message.sections ?? {};
	console.log("project_context fresh:", String(sections.project_context ?? "").includes("Project world"));
	console.log("sections:", Object.keys(sections).join(","));
console.log("skills fresh:", String(sections.skills ?? "").includes("Skill world"));
console.log("skills raw:", JSON.stringify(String(sections.skills ?? "").slice(0, 300)));
	console.log("preamble:", JSON.stringify(String(sections.preamble ?? "").slice(0, 40)));
	console.log("addendum:", JSON.stringify(String(sections.addendum ?? "")));
}
result.session.dispose();
rmSync(root, { recursive: true, force: true });
console.log("DELIVERY SMOKE OK");
