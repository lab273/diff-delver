/**
 * Finding the repository a directory is in, and what identifies it.
 *
 * A store holds one repository (DESIGN 3.2), and "the same repository" is its
 * common git directory, with symbolic links resolved, together with its object
 * format. So the repository opened from any subdirectory, through a symbolic
 * link, or from any of its linked worktrees has one store, while a nested
 * repository, a submodule or another clone each have their own. The store id is
 * a readable name from the repository's folder and a hash of that identity.
 *
 * Every git command in the reviewed repository runs with the reviewer's config
 * (`runGit`'s `config: 'reviewer'`), and none of them writes to it.
 */
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseObjectFormat, type ObjectFormat } from '#lib/core/object-format.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import { runGit, type GitCommand, type GitError, type GitOutput } from '../../git/run-git.ts';
import type { GitSourceError } from './git-source-error.ts';

export interface LocalRepository {
	/** The top of the working tree; absent for a bare repository, or from inside its .git folder. */
	readonly workTree: AbsolutePath | undefined;
	/** This worktree's git directory, which holds its index and HEAD. */
	readonly gitDir: AbsolutePath;
	/** The git directory shared by all worktrees, with symbolic links resolved: the repository's identity. */
	readonly commonDir: AbsolutePath;
	/** Where its objects are, to copy them into the store. */
	readonly objects: AbsolutePath;
	/** Its index file. */
	readonly index: AbsolutePath;
	readonly objectFormat: ObjectFormat;
	/** A shallow clone: some history was not downloaded. */
	readonly shallow: boolean;
	/** A partial clone: some objects were not downloaded. */
	readonly partialClone: boolean;
	/** The store that holds its snapshots. */
	readonly storeId: StoreId;
	/** Extra environment for every git command run in it (see `RepositoryOptions`). */
	readonly gitEnv: Readonly<Record<string, string>>;
}

export interface RepositoryOptions {
	/**
	 * Extra environment for every git command run in the repository, applied last.
	 * Tests use it to point git at a config of their own instead of the
	 * machine's, and to make git treat the repository as another user's.
	 */
	readonly gitEnv?: Readonly<Record<string, string>>;
}

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`git gave a path that is not absolute: ${path}`);
	return parsed.value;
}

/** Runs git in the reviewed repository with the reviewer's config. */
export function gitIn(
	repo: Pick<LocalRepository, 'gitEnv'>,
	cwd: AbsolutePath,
	args: readonly string[],
	extra: Omit<GitCommand, 'cwd' | 'args' | 'config'> = {}
): Promise<Result<GitOutput, GitError>> {
	return runGit({ ...extra, cwd, args, config: 'reviewer', env: { ...extra.env, ...repo.gitEnv } });
}

/** Where git runs for commands that need no working tree. */
export function gitCwd(repo: LocalRepository): AbsolutePath {
	return repo.workTree ?? repo.gitDir;
}

/** The store id for a repository: a readable name and a hash of its identity. */
export function storeIdFor(commonDir: AbsolutePath, objectFormat: ObjectFormat): StoreId {
	const folder =
		basename(commonDir) === '.git' ? basename(dirname(commonDir)) : basename(commonDir);
	const name =
		folder
			.replace(/\.git$/, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40)
			.replace(/-+$/, '') || 'repository';
	const hash = createHash('sha256')
		.update(`${objectFormat}\0${commonDir}`)
		.digest('hex')
		.slice(0, 16);
	const id = parseStoreId(`${name}-${hash}`);
	if (!id.ok) throw new Error(`Made an invalid store id: ${id.error.value}`);
	return id.value;
}

/** The repository that `directory` is in, or why there is none. */
export async function locateRepository(
	directory: AbsolutePath,
	options: RepositoryOptions = {}
): Promise<Result<LocalRepository, GitSourceError>> {
	const settings = { gitEnv: options.gitEnv ?? {} };
	const asked = await gitIn(settings, directory, [
		'rev-parse',
		'--path-format=absolute',
		'--absolute-git-dir',
		'--git-common-dir',
		'--git-path',
		'objects',
		'--git-path',
		'index',
		'--is-bare-repository',
		'--is-inside-work-tree',
		'--show-object-format',
		'--is-shallow-repository'
	]);
	if (!asked.ok) return asked;
	const [gitDir, commonDir, objects, index, bare, inside, format, shallow] = asked.value.stdout
		.toString('utf8')
		.split('\n');
	const objectFormat = parseObjectFormat(format ?? '');
	if (
		gitDir === undefined ||
		commonDir === undefined ||
		objects === undefined ||
		index === undefined ||
		!objectFormat.ok
	) {
		return err({
			kind: 'GitFailed',
			args: ['rev-parse'],
			exitCode: undefined,
			stderr: asked.value.stderr
		});
	}
	let workTree: AbsolutePath | undefined;
	if (bare !== 'true' && inside === 'true') {
		const top = await gitIn(settings, directory, ['rev-parse', '--show-toplevel']);
		if (!top.ok) return top;
		workTree = absolute(top.value.stdout.toString('utf8').replace(/\n$/, ''));
	}
	const realCommon = absolute(await realpath(commonDir));
	const promisor = await gitIn(settings, directory, [
		'config',
		'--get-regexp',
		'^(extensions\\.partialclone|remote\\..*\\.promisor)$'
	]);
	const partialClone =
		promisor.ok &&
		promisor.value.stdout
			.toString('utf8')
			.split('\n')
			.some(
				(line) =>
					line.startsWith('extensions.partialclone ') || /\.promisor (?:true|yes|on|1)$/i.test(line)
			);
	return ok({
		workTree,
		gitDir: absolute(gitDir),
		commonDir: realCommon,
		objects: absolute(objects),
		index: absolute(index),
		objectFormat: objectFormat.value,
		shallow: shallow === 'true',
		partialClone,
		storeId: storeIdFor(realCommon, objectFormat.value),
		gitEnv: settings.gitEnv
	});
}

/** The shared index files a split index refers to, which git touches when it reads the index. */
export async function sharedIndexFiles(repo: LocalRepository): Promise<readonly string[]> {
	const names = await readdir(repo.gitDir).catch(() => []);
	return names
		.filter((name) => name.startsWith('sharedindex.'))
		.map((name) => join(repo.gitDir, name));
}
