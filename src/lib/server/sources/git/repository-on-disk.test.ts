import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyRepo, tempDirectory } from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath } from '../../../../../tests/support/git-repo.ts';
import { locateRepository } from './local-repository.ts';
import { repositoryOnDisk } from './repository-on-disk.ts';

describe('the repository a folder is in, from the files alone', () => {
	it('names a repository as locateRepository does, from a sub-folder, a link or a linked worktree', async () => {
		const repo = await emptyRepo();
		await repo.write('src/a.txt', 'a\n');
		await repo.commit('first');
		const outside = await tempDirectory();
		const worktree = join(outside, 'worktree');
		await repo.git('worktree', 'add', '--quiet', worktree);
		await symlink(join(repo.dir, 'src'), join(outside, 'link'));
		const located = await locateRepository(repo.dir);
		if (!located.ok) throw new Error('no repository');
		for (const [folder, top] of [
			[repo.dir, repo.dir],
			[join(repo.dir, 'src'), repo.dir],
			[join(outside, 'link'), repo.dir],
			[worktree, worktree]
		] as const) {
			const found = await repositoryOnDisk(absolutePath(folder));
			expect(found, folder).toEqual({
				top: absolutePath(top),
				commonDir: located.value.commonDir
			});
		}
		expect(await repositoryOnDisk(outside)).toBeUndefined();
		expect(await repositoryOnDisk(absolutePath(join(outside, 'missing')))).toBeUndefined();
	});

	it('stops at the nearest thing that could be a repository, as git would or sooner', async () => {
		const repo = await emptyRepo();
		// A folder that looks like a bare repository, and one with a .git that points nowhere.
		const bare = join(repo.dir, 'looks-bare');
		await mkdir(join(bare, 'refs'), { recursive: true });
		await writeFile(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
		const broken = join(repo.dir, 'broken');
		await mkdir(broken);
		await writeFile(join(broken, '.git'), 'gitdir: /nowhere/at/all\n');
		const located = await locateRepository(repo.dir);
		if (!located.ok) throw new Error('no repository');
		const inBare = await repositoryOnDisk(absolutePath(bare));
		expect(inBare?.commonDir).not.toBe(located.value.commonDir);
		expect(await repositoryOnDisk(absolutePath(broken))).toBeUndefined();
		// A folder with only some of a git directory's names is an ordinary folder.
		const ordinary = join(repo.dir, 'src', 'objects');
		await mkdir(ordinary, { recursive: true });
		expect((await repositoryOnDisk(absolutePath(ordinary)))?.commonDir).toBe(
			located.value.commonDir
		);
	});
});
