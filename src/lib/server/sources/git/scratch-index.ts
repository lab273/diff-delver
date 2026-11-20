/**
 * A private copy of a repository's index, so the working-tree and staged sources
 * can read and write an index without touching the real one: no lock file, no
 * refreshed stat data, no index written back.
 *
 * The copy is made whole, not split and not sparse, inside a throwaway bare
 * repository of its own. A split index names a shared index file in the
 * repository's git directory, and git touches that file whenever it reads the
 * index; the shared files are copied next to the private index and git is made
 * to merge them in there, so the repository's are never read by git.
 *
 * A sparse index is expanded at the same time. Expanding reads the trees of the
 * folders left out and writes a tree for every folder, and git touches any
 * object it writes that already exists in a store it can see, so the
 * repository's objects must not be visible: expansion reads and writes only
 * `objects`, which must already hold the trees it needs (the snapshot sources
 * copy HEAD's tree into the store first). Without `objects` a sparse index
 * cannot be expanded and the copy fails, which writes nothing either.
 *
 * The copy keeps the original's modification time. git trusts an entry whose
 * file matches it in size, time and inode without reading the file, except when
 * the entry is not older than the index file itself: a file changed in the tick
 * the index was written could match on all of those and still differ, so git
 * reads such "racily clean" entries (git's Documentation/technical/racy-git.adoc).
 * A copy made now, or rewritten whole, would look newer than every entry, and a
 * change made in that tick would be lost from the snapshot. The time is set no
 * later than the original's, never later, since an earlier one only makes git
 * read a few more files.
 */
import { copyFile, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { Result } from '#lib/core/result.ts';
import { runGit } from '../../git/run-git.ts';
import { removeStaleFolders } from '../../store/index.ts';
import type { GitSourceError } from './git-source-error.ts';
import { sharedIndexFiles, type LocalRepository } from './local-repository.ts';

export interface ScratchIndex {
	/** The throwaway bare repository the copy belongs to, for commands that need no working tree. */
	readonly gitDir: AbsolutePath;
	/** The private index, for `GIT_INDEX_FILE`. Absent from disk if the repository had no index. */
	readonly index: AbsolutePath;
	/** An empty folder, for `core.hooksPath`, so no hook of the repository runs. */
	readonly noHooks: AbsolutePath;
}

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`Not an absolute path: ${path}`);
	return parsed.value;
}

/**
 * A time in seconds, as `utimes` takes it, no later than `nanoseconds`. A
 * double holds today's times to about a quarter of a microsecond, so the time
 * is taken a whole microsecond earlier, which rounding cannot undo.
 */
function noLaterThan(nanoseconds: bigint): number {
	return Number(nanoseconds / 1000n - 1n) / 1e6;
}

/** The index's modification time, or undefined when there is no index. */
async function indexTime(index: AbsolutePath): Promise<bigint | undefined> {
	return stat(index, { bigint: true }).then(
		(found) => found.mtimeNs,
		(error: unknown) => {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
			throw error;
		}
	);
}

/** How the folders of private index copies are named, in the temporary folder. */
const SCRATCH_PREFIX = 'diff-delver-index-';

/** Removes the private index copies a crash left behind, once they are an hour old. */
export function removeStaleScratchIndexes(): Promise<void> {
	return removeStaleFolders(absolute(tmpdir()), SCRATCH_PREFIX);
}

/** The settings every command given a scratch index runs with. */
export function scratchSettings(scratch: ScratchIndex): readonly string[] {
	return [
		'-c',
		'core.splitIndex=false',
		'-c',
		'index.sparse=false',
		'-c',
		'core.fsmonitor=false',
		'-c',
		`core.hooksPath=${scratch.noHooks}`
	];
}

/**
 * Runs `work` with a private, whole copy of the repository's index, and removes
 * the copy afterwards however `work` ends. `objects` is the only object
 * directory git may use while making the copy (see the top of this file).
 */
export async function withScratchIndex<T, E>(
	repo: LocalRepository,
	objects: AbsolutePath | undefined,
	work: (scratch: ScratchIndex) => Promise<Result<T, E>>
): Promise<Result<T, E | GitSourceError>> {
	const dir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
	try {
		const scratch: ScratchIndex = {
			gitDir: absolute(join(dir, 'repo')),
			index: absolute(join(dir, 'repo', 'index')),
			noHooks: absolute(join(dir, 'no-hooks'))
		};
		await mkdir(scratch.noHooks);
		const init = await runGit({
			cwd: absolute(dir),
			args: ['init', '--quiet', '--bare', `--object-format=${repo.objectFormat}`, 'repo']
		});
		if (!init.ok) return init;
		// Read before copying: if the index is written in between, the copy is only
		// older than its contents, which makes git read more files, never fewer.
		const time = await indexTime(repo.index);
		const copied = await copyFile(repo.index, scratch.index).then(
			() => true,
			(error: unknown) => {
				if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
				throw error;
			}
		);
		if (copied) {
			for (const shared of await sharedIndexFiles(repo)) {
				await copyFile(shared, join(scratch.gitDir, basename(shared)));
			}
			const whole = await runGit({
				cwd: scratch.gitDir,
				args: [...scratchSettings(scratch), 'update-index', '--no-split-index'],
				env: {
					GIT_INDEX_FILE: scratch.index,
					GIT_NO_LAZY_FETCH: '1',
					...(objects === undefined ? {} : { GIT_OBJECT_DIRECTORY: objects })
				}
			});
			if (!whole.ok) return whole;
			// Copied, and rewritten whole when it was split, the copy is as new as now:
			// give it the original's time back.
			if (time !== undefined) {
				const seconds = noLaterThan(time);
				await utimes(scratch.index, seconds, seconds);
			}
		}
		return await work(scratch);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
