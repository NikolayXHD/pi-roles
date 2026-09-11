/**
 * Live check of required extension registration: a `pi-subagents` stub in
 * the pi npm root confirms the call
 * `registerRequiredChildExtensions({sessionId, extensions: [{id, path}]})`.
 * Expectation — `REGISTRATION SMOKE OK`, the marker has our id and the
 * index.ts path.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, PI } from "./sdk.mjs";

const pi = await import(PI);

const root = mkdtempSync(join(tmpdir(), "pi-template-reg-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.REG_MARKER = join(root, "registered.json");
mkdirSync(projectDir, { recursive: true });
// pi-subagents stub in the pi npm root
const pkgDir = join(agentDir, "npm", "node_modules", "pi-subagents");
mkdirSync(join(pkgDir, "src", "api"), { recursive: true });
writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
	name: "pi-subagents", version: "0.0.0", type: "module",
	exports: { "./required-child-extensions": { default: "./src/api/required-child-extensions.js" } },
}));
writeFileSync(join(pkgDir, "src", "api", "required-child-extensions.js"), `
import { writeFileSync } from "node:fs";
export function registerRequiredChildExtensions(input) {
	writeFileSync(process.env.REG_MARKER, JSON.stringify(input));
	return { dispose() {} };
}
`);

const settingsManager = pi.SettingsManager.create(projectDir, agentDir);
const modelRuntime = await pi.ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
	modelsStorePath: join(agentDir, "models-store.json"),
	allowModelNetwork: false,
});
modelRuntime.registerProvider("fake", {
	name: "Fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fake",
	models: [{ id: "fake", name: "Fake", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
});
const model = modelRuntime.getModel("fake", "fake");
const loader = new pi.DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager, additionalExtensionPaths: [EXT], noExtensions: true, noThemes: true });
await loader.reload();
const result = await pi.createAgentSession({
	cwd: projectDir, agentDir, modelRuntime, model, thinkingLevel: "low",
	resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(projectDir), settingsManager,
});
await result.session.bindExtensions({});
const marker = existsSync(process.env.REG_MARKER) ? JSON.parse(readFileSync(process.env.REG_MARKER, "utf-8")) : undefined;
console.log("registration:", JSON.stringify(marker));
if (!marker || marker.extensions?.[0]?.id !== "pi-template" || marker.extensions[0].path !== EXT) {
	throw new Error("required extension registration did not work");
}
result.session.dispose();
rmSync(root, { recursive: true, force: true });
console.log("REGISTRATION SMOKE OK");
