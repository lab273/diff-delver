/**
 * The repositories of the diffs listed, for "Choose commits or a branch": each
 * once, with whether its folder is still there, so a page never offers a link
 * to a folder that has been moved or deleted.
 */
import { stat } from 'node:fs/promises';
import type { ListedDiff, ListedRepository } from '#lib/api/schemas.ts';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { knownRepositories } from '#lib/core/reports/switch-delves.ts';

async function folderThere(path: AbsolutePath): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function listedRepositories(
	diffs: readonly ListedDiff[]
): Promise<ListedRepository[]> {
	const known = knownRepositories(diffs.filter((diff) => diff.kind === 'diff'));
	return Promise.all(
		known.map(async (repository) => ({
			...repository,
			there: await folderThere(repository.directory)
		}))
	);
}
