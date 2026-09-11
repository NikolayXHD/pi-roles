/**
 * Cross-process lock of target files: a `<target>.lock` directory with an
 * owner marker (`owner.json` — token, pid, time). The lock is held only
 * around foreign reads of a target file (read tool, spawn and the agent
 * directory): the extension re-renders the target file under the applied
 * view, keeps the lock until the reader has read, and releases it. Content
 * delivery into the prompt takes no lock; rendering without a foreign read
 * runs freely.
 *
 * Properties:
 * - re-entrant within a session scope: parallel reads of one model reply
 *   aim at a shared file and do not block each other — a depth counter per
 *   scope+path pair. Different sessions of one process (parent and
 *   foreground children) do not share depth: foreign locks are foreign;
 * - ownership is limited by a short timeout (`LOCK_TTL_MS`): a marker older
 *   than the timeout is stale; a stale lock is taken over by renaming the
 *   directory to a temporary one plus removal (the loser touches nothing);
 * - writing the target file and releasing the lock only under confirmed
 *   ownership (the marker token matches): a loser does not write and does
 *   not release a foreign lock, but repeats the re-render;
 * - FS errors are not thrown out: `acquireLock`/`writeTargetUnderLock`
 *   report a problem via callback and return `null`/`failed`;
 * - the lock form (an mkdir directory) and name (`<target>.lock`) are
 *   implementation details.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Ownership timeout: an older marker is stale, the lock may be taken over. */
export const LOCK_TTL_MS = 10_000;
/** How long to wait for a busy (fresh) lock before giving up. */
export const LOCK_WAIT_MS = 1_500;

export interface LockHandle {
	/** Absolute path of the target file. */
	readonly target: string;
	/** Lock directory. */
	readonly dir: string;
	/** Owner token — compared with the marker on write and release. */
	readonly token: string;
	/** Ownership scope (session): re-entry depth is counted per it. */
	readonly scope: string;
}

export type TargetWrite = "written" | "unchanged" | "lost" | "failed";

export interface LockOptions {
	/** How long to wait for a busy (fresh) lock. */
	waitMs?: number;
	/** Ownership timeout. */
	ttlMs?: number;
	/** Re-entry scope: each session has its own. */
	scope?: string;
	/** FS error: the lock attempt failed, we do not throw out. */
	onProblem?: (message: string) => void;
}

interface HeldLock {
	handle: LockHandle;
	depth: number;
}

/** Locks held by this process: `scope\0path` → ownership depth. */
const held = new Map<string, HeldLock>();

function heldKey(scope: string, target: string): string {
	return `${scope}\u0000${target}`;
}

function ownerFile(dir: string): string {
	return join(dir, "owner.json");
}

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Lock age: marker time, else directory mtime, else 0 (no lock). */
function lockAge(dir: string, now: number): number {
	let at: number | undefined;
	try {
		const parsed = JSON.parse(readFileSync(ownerFile(dir), "utf-8")) as { at?: unknown };
		if (typeof parsed?.at === "number") at = parsed.at;
	} catch {
		// No marker or a broken one — fall back to the directory mtime.
	}
	if (at === undefined) {
		try {
			at = statSync(dir).mtimeMs;
		} catch {
			return 0;
		}
	}
	return Math.max(0, now - at);
}

function ownerToken(dir: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(ownerFile(dir), "utf-8")) as { token?: unknown };
		return typeof parsed?.token === "string" ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Stale lock takeover: rename the directory to a temporary one plus
 * removal. Rename failed — the lock is already released/taken by someone
 * else, leave it alone.
 */
function takeStaleLock(dir: string): void {
	const stale = `${dir}.stale.${randomBytes(4).toString("hex")}`;
	try {
		renameSync(dir, stale);
	} catch {
		return;
	}
	try {
		rmSync(stale, { recursive: true, force: true });
	} catch {
		// The temporary directory is left behind — TTL or system cleanup removes it.
	}
}

/**
 * Acquire a lock on a target file in the session scope. Re-entry of the
 * same scope gives the same token and increases depth. A fresh foreign
 * lock is waited for up to `waitMs`; a stale one is taken over by rename
 * and acquired again; a busy lock after the wait gives `null`. FS error —
 * a message to `onProblem` and `null`, nothing thrown out.
 */
export async function acquireLock(targetPath: string, options?: LockOptions): Promise<LockHandle | null> {
	const target = resolve(targetPath);
	const scope = options?.scope ?? "process";
	const key = heldKey(scope, target);
	const reentrant = held.get(key);
	if (reentrant) {
		// Re-entry only with live ownership: a stale lock of this scope starts
		// acquisition anew instead of returning a dead token.
		if (ownsLock(reentrant.handle)) {
			reentrant.depth += 1;
			return reentrant.handle;
		}
		held.delete(key);
	}

	const dir = `${target}.lock`;
	const waitMs = options?.waitMs ?? LOCK_WAIT_MS;
	const ttlMs = options?.ttlMs ?? LOCK_TTL_MS;
	const deadline = Date.now() + waitMs;

	for (;;) {
		let created = false;
		try {
			// No recursive: an existing directory must give EEXIST.
			mkdirSync(dir);
			created = true;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				options?.onProblem?.(`lock ${dir} not acquired: ${errorMessage(error)}`);
				return null;
			}
		}
		if (!created) {
			const token = ownerToken(dir);
			const age = lockAge(dir, Date.now());
			// Without a marker a fresh directory is a foreign acquisition in progress.
			if (token === undefined || age <= ttlMs) {
				if (Date.now() >= deadline) return null;
				await sleep(25);
				continue;
			}
			// Stale: take over by rename and try again.
			takeStaleLock(dir);
			continue;
		}
		try {
			const token = randomBytes(16).toString("hex");
			writeFileSync(ownerFile(dir), JSON.stringify({ token, pid: process.pid, at: Date.now() }));
			const handle: LockHandle = { target, dir, token, scope };
			held.set(key, { handle, depth: 1 });
			return handle;
		} catch (error) {
			// The marker was not written — remove our empty directory and report.
			rmSync(dir, { recursive: true, force: true });
			options?.onProblem?.(`lock marker ${dir} not written: ${errorMessage(error)}`);
			return null;
		}
	}
}

/** Confirmed ownership: the marker on disk belongs to this token. */
export function ownsLock(handle: LockHandle): boolean {
	return ownerToken(handle.dir) === handle.token;
}

/**
 * Release a lock. Depth above one only decreases; at the last level the
 * lock is released only under confirmed ownership — a foreign one is left alone.
 */
export function releaseLock(handle: LockHandle): void {
	const key = heldKey(handle.scope, handle.target);
	const entry = held.get(key);
	if (!entry || entry.handle.token !== handle.token) return;
	if (entry.depth > 1) {
		entry.depth -= 1;
		return;
	}
	held.delete(key);
	if (ownsLock(handle)) {
		try {
			rmSync(handle.dir, { recursive: true, force: true });
		} catch {
			// The lock will expire; we do not fail the tool call.
		}
	}
}

/**
 * Write a target file under confirmed ownership: a temporary file next to
 * it plus rename. `lost` — ownership lost, `failed` — FS error; in both
 * cases the target file is untouched.
 */
export function writeTargetUnderLock(handle: LockHandle, text: string, onProblem?: (message: string) => void): TargetWrite {
	if (!ownsLock(handle)) return "lost";
	try {
		if (readFileSync(handle.target, "utf-8") === text) return "unchanged";
	} catch {
		// No target file — write.
	}
	const temporary = `${handle.target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, text);
		renameSync(temporary, handle.target);
		return "written";
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// The temporary file is gone — nothing to clean up.
		}
		onProblem?.(`target ${handle.target} not written: ${errorMessage(error)}`);
		return "failed";
	}
}
