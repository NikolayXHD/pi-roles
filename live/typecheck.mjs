/**
 * Package type check: generates `tsconfig.json` in a temporary directory
 * (paths to the pi SDK and its types are machine-dependent and do not go
 * into the repository) and runs `tsc` from PATH.
 *
 * Run: node live/typecheck.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const globalModules = join(dirname(dirname(process.execPath)), "lib", "node_modules");
const piRoot = join(globalModules, "@earendil-works", "pi-coding-agent");
const piTypes = join(piRoot, "dist", "index.d.ts");
const piTuiTypes = join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts");
const nodeTypeRoots = join(piRoot, "node_modules", "@types");
for (const path of [piTypes, piTuiTypes, nodeTypeRoots]) {
	if (!existsSync(path)) {
		throw new Error(`not found: ${path} — run the check with the node under which pi is installed globally`);
	}
}

const config = {
	compilerOptions: {
		noEmit: true,
		strict: true,
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "bundler",
		allowImportingTsExtensions: true,
		skipLibCheck: true,
		types: ["node"],
		typeRoots: [nodeTypeRoots],
		paths: {
			"@earendil-works/pi-coding-agent": [piTypes],
			"@earendil-works/pi-tui": [piTuiTypes],
		},
	},
	include: [join(packageRoot, "*.ts")],
};

const dir = mkdtempSync(join(tmpdir(), "pi-template-tsc-"));
const configPath = join(dir, "tsconfig.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const result = spawnSync("tsc", ["--project", configPath], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
if (result.error) {
	console.error(`tsc did not start: ${result.error.message} — tsc is required in PATH`);
	process.exitCode = 1;
} else if (result.status !== 0) {
	console.error("TYPECHECK FAIL");
	process.exitCode = result.status ?? 1;
} else {
	console.log("TYPECHECK OK");
}
