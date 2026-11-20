/**
 * Builds real git repositories for tests and scripts by running real git commands.
 *
 * Independent of the machine's git setup: `runGit` ignores the system and global
 * config, and every commit gets a fixed identity and date, so the same script gives
 * the same commit and tree ids everywhere. Nothing here knows about Vitest; see
 * `fixture-repos.ts` for the per-run cache that tests use.
 */
import { chmod, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import { describeGitError, runGit } from '#lib/server/git/run-git.ts';

const IDENTITY = {
	GIT_AUTHOR_NAME: 'Fixture Author',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_NAME: 'Fixture Author',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
};

export interface Snapshot {
	readonly commit: CommitId;
	readonly tree: TreeId;
}

/** Turns a test's path string into an `AbsolutePath`, failing loudly if it is not one. */
export function absolutePath(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`Not an absolute path: ${path}`);
	return parsed.value;
}

export interface RepoOptions {
	readonly objectFormat?: 'sha1' | 'sha256';
}

export class GitRepo {
	readonly dir: AbsolutePath;
	/** Submodule entries, re-applied to the index on every commit. */
	readonly #gitlinks = new Map<string, CommitId>();
	#commits = 0;

	private constructor(dir: AbsolutePath) {
		this.dir = dir;
	}

	/** Creates an empty repository with `main` as its branch, in a directory that need not exist. */
	static async init(dir: AbsolutePath, options: RepoOptions = {}): Promise<GitRepo> {
		await mkdir(dir, { recursive: true });
		const repo = new GitRepo(dir);
		await repo.git(
			'init',
			'--quiet',
			'--initial-branch=main',
			`--object-format=${options.objectFormat ?? 'sha1'}`
		);
		for (const [key, value] of [
			['commit.gpgsign', 'false'],
			['tag.gpgsign', 'false'],
			['core.autocrlf', 'false'],
			['core.symlinks', 'true'],
			['core.fileMode', 'true']
		] as const) {
			await repo.git('config', key, value);
		}
		return repo;
	}

	/** Opens an existing repository built by this class, such as a copied fixture. */
	static open(dir: AbsolutePath): GitRepo {
		return new GitRepo(dir);
	}

	/** Runs git in the repository and returns stdout. Throws if git fails. */
	async git(...args: readonly string[]): Promise<string> {
		const date = `${String(1_700_000_000 + this.#commits * 60)} +0000`;
		const result = await runGit({
			cwd: this.dir,
			args,
			env: { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
		});
		if (!result.ok) {
			const detail = 'stderr' in result.error ? `\n${result.error.stderr}` : '';
			throw new Error(`git ${args.join(' ')}: ${describeGitError(result.error)}${detail}`);
		}
		return result.value.stdout.toString('utf8');
	}

	#path(path: string): string {
		return join(this.dir, path);
	}

	/** Writes a file, creating its directories. */
	async write(path: string, content: string | Uint8Array): Promise<void> {
		await mkdir(dirname(this.#path(path)), { recursive: true });
		await rm(this.#path(path), { force: true });
		await writeFile(this.#path(path), content);
	}

	/** Replaces whatever is at `path` with a symbolic link to `target`. */
	async symlink(path: string, target: string): Promise<void> {
		await mkdir(dirname(this.#path(path)), { recursive: true });
		await rm(this.#path(path), { force: true });
		await symlink(target, this.#path(path));
	}

	/**
	 * Writes a file whose path is given as bytes, which need not be UTF-8, creating
	 * its directories.
	 */
	async writeRaw(path: Uint8Array, content: string | Uint8Array): Promise<void> {
		const full = Buffer.concat([Buffer.from(`${this.dir}/`), path]);
		const slash = full.lastIndexOf(0x2f);
		await mkdir(full.subarray(0, slash), { recursive: true });
		await writeFile(full, content);
	}

	/** Removes a file or directory whose path is given as bytes. */
	async removeRaw(path: Uint8Array): Promise<void> {
		await rm(Buffer.concat([Buffer.from(`${this.dir}/`), path]), { recursive: true, force: true });
	}

	async setExecutable(path: string, executable: boolean): Promise<void> {
		await chmod(this.#path(path), executable ? 0o755 : 0o644);
	}

	async remove(path: string): Promise<void> {
		await rm(this.#path(path), { recursive: true, force: true });
	}

	async move(from: string, to: string): Promise<void> {
		await mkdir(dirname(this.#path(to)), { recursive: true });
		await rename(this.#path(from), this.#path(to));
	}

	/** Records a submodule entry at `path` pointing at `commit`, without a real submodule. */
	setGitlink(path: string, commit: CommitId): void {
		this.#gitlinks.set(path, commit);
	}

	async removeGitlink(path: string): Promise<void> {
		this.#gitlinks.delete(path);
		await this.git('update-index', '--force-remove', '--', path);
	}

	/** Stages everything and commits it, returning the commit and its tree. Tags it if asked. */
	async commit(message: string, tag?: string): Promise<Snapshot> {
		await this.git('add', '--all');
		for (const [path, commit] of this.#gitlinks) {
			await this.git('update-index', '--add', '--cacheinfo', `160000,${commit},${path}`);
		}
		await this.git('commit', '--quiet', '--allow-empty', '--no-verify', '-m', message);
		this.#commits += 1;
		if (tag !== undefined) await this.git('tag', tag);
		return this.snapshot('HEAD');
	}

	/** The commit and tree a revision such as a tag names. */
	async snapshot(revision: string): Promise<Snapshot> {
		const output = await this.git(
			'rev-parse',
			'--verify',
			'--end-of-options',
			`${revision}^{commit}`
		);
		const commit = parseCommitId(output.trim());
		const tree = parseTreeId((await this.git('rev-parse', `${output.trim()}^{tree}`)).trim());
		if (!commit.ok || !tree.ok) throw new Error(`Unexpected rev-parse output for ${revision}`);
		return { commit: commit.value, tree: tree.value };
	}
}

/** A named repository and the script that builds it. */
export interface Fixture {
	readonly name: string;
	/**
	 * Builds the repository. Tag the commits that tests need and read them back
	 * with `repo.snapshot(tag)`.
	 */
	readonly build: (repo: GitRepo) => Promise<void>;
	readonly options: RepoOptions;
}

/** Names a fixture repository and the script that builds it. */
export function defineFixture(
	name: string,
	build: (repo: GitRepo) => Promise<void>,
	options: RepoOptions = {}
): Fixture {
	return { name, build, options };
}
