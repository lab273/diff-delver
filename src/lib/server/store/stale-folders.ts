/**
 * Removing what a crash left behind: folders diff delver makes for a moment and
 * removes when it is done, such as a store being built (`stores/.new-*`, swept
 * when a store is made), a private copy of an index (`diff-delver-index-*` in
 * the temporary folder, swept when one is made) or a pull request's download
 * under way (`diff-delver-incoming-*` in its store, swept when the next one
 * starts and when the stores are tidied). One untouched for `GRACE_PERIOD`
 * belongs to no work still running.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { millisecondsOf, type Milliseconds } from '#lib/core/milliseconds.tiny.ts';

/**
 * How long an object no snapshot refers to is kept, and how long a leftover
 * folder is left alone. Another process may be taking a snapshot: between
 * writing its trees and pinning them they are unreferenced, and the store lock
 * only orders this process's own work. An hour is far longer than any snapshot
 * takes, so no lock between processes is needed.
 */
export const GRACE_PERIOD: Milliseconds = millisecondsOf(60 * 60 * 1000);

/** The names diff delver gives its short-lived folders. */
export type ShortLivedFolder = '.new-' | 'diff-delver-index-' | 'diff-delver-incoming-';

/**
 * Removes the folders in `directory` whose names start with `prefix` and that
 * have not been modified for `GRACE_PERIOD`. Best effort: a folder that cannot
 * be read or removed is left as it is, since nothing depends on its going.
 */
export async function removeStaleFolders(
	directory: AbsolutePath,
	prefix: ShortLivedFolder
): Promise<void> {
	const names = await readdir(directory).catch(() => []);
	const before = Date.now() - GRACE_PERIOD;
	await Promise.all(
		names
			.filter((name) => name.startsWith(prefix))
			.map(async (name) => {
				const path = join(directory, name);
				const info = await stat(path).catch(() => undefined);
				if (info?.isDirectory() === true && info.mtimeMs < before) {
					await rm(path, { recursive: true, force: true }).catch(() => undefined);
				}
			})
	);
}
