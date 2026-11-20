/**
 * The reviewer's own git setup, for tests of code that runs git with it
 * (`runGit`'s `config: 'reviewer'`): a home folder and global config made for
 * the test, never the machine's, so results do not depend on who runs them.
 */
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import { runGit } from '#lib/server/git/run-git.ts';
import { tempDirectory } from './fixture-repos.ts';
import { absolutePath } from './git-repo.ts';

export interface Reviewer {
	/** Extra environment for git, as `RepositoryOptions.gitEnv` takes it. */
	readonly gitEnv: Readonly<Record<string, string>>;
	/** The reviewer's home folder. */
	readonly home: AbsolutePath;
}

/** A reviewer whose global git config is `globalConfig`, with no system config. */
export async function reviewer(globalConfig = ''): Promise<Reviewer> {
	const home = await tempDirectory();
	await mkdir(join(home, 'xdg'));
	await writeFile(join(home, 'gitconfig'), globalConfig);
	return {
		home,
		gitEnv: {
			HOME: home,
			XDG_CONFIG_HOME: join(home, 'xdg'),
			GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
			GIT_CONFIG_NOSYSTEM: '1'
		}
	};
}

/**
 * The tree real git would commit from the working tree, worked out with
 * `git add --all` and `git write-tree` in a copy of the repository, with the
 * reviewer's config.
 */
export async function treeGitWouldCommit(dir: AbsolutePath, who: Reviewer): Promise<TreeId> {
	const copy = absolutePath(join(await tempDirectory(), 'copy'));
	await cp(dir, copy, { recursive: true, verbatimSymlinks: true });
	const run = (args: readonly string[]) =>
		runGit({ cwd: copy, args, config: 'reviewer', env: who.gitEnv });
	const added = await run(['add', '--all', '--ignore-errors']);
	if (!added.ok && !(added.error.kind === 'GitFailed' && added.error.exitCode === 1)) {
		throw new Error(`git add failed in the copy: ${JSON.stringify(added.error)}`);
	}
	const written = await run(['write-tree']);
	if (!written.ok)
		throw new Error(`git write-tree failed in the copy: ${JSON.stringify(written.error)}`);
	const tree = parseTreeId(written.value.stdout.toString('utf8').trim());
	if (!tree.ok) throw new Error('write-tree gave no tree');
	return tree.value;
}
