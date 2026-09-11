/**
 * Shared paths for the package live checks (the `live/` directory).
 *
 * `EXT` is the extension entry point, relative to this file. `PI` is the pi
 * SDK from the global node_modules of the installation whose `node` runs the
 * script (nvm and the like): `pi-template` does not depend on the SDK in its
 * own `node_modules`, and the checks run against the installed pi.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXT = fileURLToPath(new URL("../index.ts", import.meta.url));

const globalModules = join(dirname(dirname(process.execPath)), "lib", "node_modules");
export const PI = join(globalModules, "@earendil-works/pi-coding-agent", "dist", "index.js");

if (!existsSync(PI)) {
	throw new Error(
		`pi SDK not found: ${PI} — run the check with the node under which pi is installed globally (an nvm install of pi)`,
	);
}
