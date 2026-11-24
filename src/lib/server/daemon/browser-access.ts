/**
 * What lets a browser write the person's drafts (DESIGN 9), kept in the data
 * folder as `browser-access.json` so that a browser keeps it when the daemon
 * restarts, as after an upgrade or `diff-delver stop`: the token its review
 * cookie holds, and the id the cookie is named by.
 *
 * Keeping it gives an agent no new way in. `/mcp` takes no cookie, and the
 * tools read only snapshots of the repository the agent was started in, never
 * the data folder as such. The file is the person's alone (the folder is made
 * 0700 and the file 0600), as the lockfile beside it is, whose token can
 * already be turned into a review code while a daemon runs; so whoever can
 * read this file could have had review access before it existed. That
 * includes one case to know of: a data folder placed inside the reviewed
 * repository, and not ignored there, is part of the snapshots, and then an
 * agent's tools list and read both files. That was already so of the
 * lockfile, and is a matter of where the data folder may be, not of this file.
 *
 * What does change is how long a cookie that got out stays good: across
 * daemons, not until the daemon stops. A cookie gets out only the way DESIGN 9
 * already accepts, to another server on this machine that the person's
 * browser visits.
 *
 * To take review access from every browser: stop the daemon (`diff-delver
 * stop`), delete the file, and start diff delver again, which makes a new one.
 * Deleting it while a daemon runs changes nothing until then, because a
 * daemon reads it once, when it starts.
 *
 * Only a plain file of the person's own, that nobody else may read, is
 * trusted. One that cannot be read, is not one of ours, is a link or anything
 * else that is not a plain file, belongs to someone else, or that others on
 * the machine may read, is replaced. When the folder cannot be written the
 * daemon still runs, with access that lasts until it stops, as every daemon's
 * did before the file was kept.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
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

/**
 * Whether the file is the person's own and nobody else may read it. Windows
 * has neither owners of this kind nor these bits, and keeps the folder private
 * another way.
 */
function isPrivate(file: { readonly mode: number; readonly uid: number }): boolean {
	if (process.platform === 'win32') return true;
	return (file.mode & 0o077) === 0 && file.uid === process.getuid?.();
}

async function read(path: string): Promise<BrowserAccess | undefined> {
	try {
		// Opened without following a link, and judged by what was opened, so what
		// is checked is what is read.
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const found = await handle.stat();
			if (!found.isFile() || !isPrivate(found)) return undefined;
			const file = FileSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
			return file.success ? file.data : undefined;
		} finally {
			await handle.close();
		}
	} catch {
		// Not there, a link, not readable, or not JSON: there is nothing kept to use.
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
