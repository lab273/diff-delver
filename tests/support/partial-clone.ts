/**
 * Partial clones for tests: a server repository and a clone of it that left
 * objects behind, as `git clone --filter` does. Whatever the clone lacks, git
 * would fetch from the server on demand, so a test that lists the clone before
 * and after proves that nothing was fetched into it.
 */
import { join } from 'node:path';
import { emptyRepo, tempDirectory } from './fixture-repos.ts';
import { absolutePath, GitRepo } from './git-repo.ts';

/** What the clone leaves out: every file's contents (`blob:none`), or every tree too (`tree:0`). */
export type CloneFilter = 'blob:none' | 'tree:0';

export interface PartialClone {
	readonly server: GitRepo;
	readonly clone: GitRepo;
}

const lines = (count: number): string =>
	Array.from({ length: count }, (_, i) => `line ${String(i + 1)}\n`).join('');

/**
 * A server with `main` and a branch `feat` that renames and edits a file, and
 * a clone with `feat` checked out. Only the files of `feat` were downloaded, so
 * the old side of the rename, and in a treeless clone `main`'s trees, are
 * missing from the clone.
 */
export async function partialClone(filter: CloneFilter): Promise<PartialClone> {
	const server = await emptyRepo();
	await server.git('config', 'uploadpack.allowFilter', 'true');
	await server.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
	await server.write('d/a.txt', lines(100));
	await server.write('b.txt', 'b\n');
	await server.commit('base');
	await server.git('checkout', '--quiet', '-b', 'feat');
	await server.move('d/a.txt', 'd/c.txt');
	await server.write('d/c.txt', lines(101));
	await server.commit('rename and edit');
	await server.git('checkout', '--quiet', 'main');
	const dir = absolutePath(join(await tempDirectory(), `clone-${filter.replace(':', '-')}`));
	await server.git(
		'clone',
		'--quiet',
		`--filter=${filter}`,
		'--branch=feat',
		`file://${server.dir}`,
		dir
	);
	return { server, clone: GitRepo.open(dir) };
}
