/**
 * Shared steps for the git source tests: take a snapshot of a source while
 * proving that the repository was not written to, and summarise the diff.
 */
import { expect } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import type { Result } from '#lib/core/result.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import {
	locateRepository,
	snapshotGitSource,
	type GitSnapshot,
	type GitSourceError,
	type LocalRepository
} from '#lib/server/sources/git/index.ts';
import { readSnapshotDiff, type Snapshot } from '#lib/server/store/index.ts';
import { listingsAround } from './directory-listing.ts';
import { tempDirectory } from './fixture-repos.ts';
import type { Reviewer } from './reviewer-git.ts';

/** Fails the test with the error if the result is one. */
export function value<T>(result: Result<T, unknown>): T {
	if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
	return result.value;
}

/** The repository at `dir`, located with the reviewer's setup. */
export async function located(dir: AbsolutePath, who: Reviewer): Promise<LocalRepository> {
	return value(await locateRepository(dir, { gitEnv: who.gitEnv }));
}

export interface Taking {
	readonly dataDirectory?: AbsolutePath;
	/** Directories that must not change, besides `dir`. */
	readonly alsoWatch?: readonly string[];
}

/**
 * Locates the repository at `dir` and snapshots the source typed as `source`,
 * and expects every watched directory to be exactly as it was, whether it
 * succeeds or fails.
 */
export async function take(
	dir: AbsolutePath,
	source: string,
	who: Reviewer,
	taking: Taking = {}
): Promise<Result<GitSnapshot, GitSourceError>> {
	const spec = value(parseGitSourceSpec(source));
	const dataDirectory = taking.dataDirectory ?? (await tempDirectory());
	const { before, after, result } = await listingsAround(
		[dir, ...(taking.alsoWatch ?? [])],
		async () => {
			const repo = await locateRepository(dir, { gitEnv: who.gitEnv });
			return repo.ok ? snapshotGitSource(dataDirectory, repo.value, spec) : repo;
		}
	);
	expect(after).toEqual(before);
	return result;
}

/** Each changed file of the snapshot, by its escaped path, with how it changed. */
export async function changesOf(snapshot: Snapshot): Promise<Record<string, string>> {
	const files = value(await readSnapshotDiff(snapshot));
	return Object.fromEntries(
		files.map((file) => [
			escapedRepoPath(file.path),
			file.status === 'renamed' || file.status === 'copied'
				? `${file.status} from ${escapedRepoPath(file.old?.path ?? file.path)}`
				: file.status
		])
	);
}
