/**
 * What lets a browser write the person's drafts (DESIGN 9), kept in the data
 * folder as `browser-access.json` so that a browser keeps it when the daemon
 * restarts, as after an upgrade or `diff-delver stop`: the token its review
 * cookie holds, and the id the cookie is named by.
 *
 * Keeping it changes nothing an agent can reach. No MCP tool reads the data
 * folder, and `/mcp` takes no cookie. The file is the person's alone (the
 * folder is made 0700 and the file 0600), as the lockfile beside it is, whose
 * token can already be turned into a review code while a daemon runs; so
 * whoever can read this file could have had review access before it existed.
 * What does change is how long a cookie that got out stays good: until this
 * file is deleted, not until the daemon stops. A cookie gets out only the way
 * DESIGN 9 already accepts, to another server on this machine that the
 * person's browser visits. Deleting the file takes review access from every
 * browser; the next daemon makes a new one.
 *
 * A file that cannot be read, is not one of ours, or that others on the
 * machine may read is not trusted: it is replaced. When the folder cannot be
 * written the daemon still runs, with access that lasts until it stops, as
 * every daemon's did before the file was kept.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseBrowserAccessId, type BrowserAccessId } from '#lib/core/browser-access-id.tiny.ts';
import { parseDaemonToken, type DaemonToken } from '#lib/core/daemon-token.tiny.ts';
import type { Result } from '#lib/core/result.ts';

export const BROWSER_ACCESS_FILE = 'browser-access.json';

export interface BrowserAccess {
	readonly id: BrowserAccessId;
	readonly token: DaemonToken;
	/** Why it lasts only until this daemon stops, when it could not be kept. */
	readonly notKept?: string;
}

function parsed<T>(parse: (value: string) => Result<T, unknown>): z.ZodType<T> {
	return z.string().transform((value, context) => {
		const result = parse(value);
		if (result.ok) return result.value;
		context.addIssue({ code: 'custom', message: 'not valid here' });
		return z.NEVER;
	});
}

const FileSchema = z.strictObject({
	id: parsed(parseBrowserAccessId),
	token: parsed(parseDaemonToken)
});

/** Whether only its owner may read the file. Windows has no such bits, and keeps the folder private another way. */
function ownerOnly(mode: number): boolean {
	return process.platform === 'win32' || (mode & 0o077) === 0;
}

async function read(path: string): Promise<BrowserAccess | undefined> {
	try {
		if (!ownerOnly((await stat(path)).mode)) return undefined;
		const file = FileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
		return file.success ? file.data : undefined;
	} catch {
		// Not there, not readable, or not JSON: there is nothing kept to use.
		return undefined;
	}
}

function made(): BrowserAccess {
	const id = parseBrowserAccessId(randomBytes(8).toString('hex'));
	const token = parseDaemonToken(randomBytes(32).toString('hex'));
	if (!id.ok || !token.ok) throw new Error('Random browser access did not parse.');
	return { id: id.value, token: token.value };
}

/**
 * The data folder's browser access: the one kept there, or a new one, kept
 * for next time. Called by the daemon that holds the folder's lock, so no
 * other writes it meanwhile. The folder exists: the lock is in it.
 */
export async function browserAccess(dataDirectory: AbsolutePath): Promise<BrowserAccess> {
	const path = join(dataDirectory, BROWSER_ACCESS_FILE);
	const kept = await read(path);
	if (kept !== undefined) return kept;
	const access = made();
	// Whole or not at all, and never readable by others, even for a moment.
	const pending = `${path}.${randomBytes(8).toString('hex')}.pending`;
	try {
		await writeFile(pending, `${JSON.stringify({ id: access.id, token: access.token })}\n`, {
			mode: 0o600,
			flag: 'wx'
		});
		await rename(pending, path);
		return access;
	} catch (error) {
		await rm(pending, { force: true }).catch(() => undefined);
		return { ...access, notKept: error instanceof Error ? error.message : String(error) };
	}
}
