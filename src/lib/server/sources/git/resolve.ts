/** Resolving what a person typed to the commits and trees of a local repository. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { Revision } from '#lib/core/revision.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import type { GitSourceError } from './git-source-error.ts';
import { gitCwd, gitIn, type LocalRepository } from './local-repository.ts';

function firstLine(stdout: Buffer): string {
	return stdout.toString('utf8').split('\n')[0] ?? '';
}

/** The commit HEAD is at, or undefined when the repository has no commits yet. */
export async function headCommit(
	repo: LocalRepository
): Promise<Result<CommitId | undefined, GitSourceError>> {
	const head = await gitIn(repo, gitCwd(repo), [
		'rev-parse',
		'--verify',
		'--quiet',
		'HEAD^{commit}'
	]);
	if (!head.ok) return head.error.kind === 'GitFailed' ? ok(undefined) : head;
	const id = parseCommitId(firstLine(head.value.stdout));
	return id.ok ? ok(id.value) : ok(undefined);
}

/** The commit a revision names now. */
export async function resolveCommit(
	repo: LocalRepository,
	revision: Revision
): Promise<Result<CommitId, GitSourceError>> {
	const resolved = await gitIn(repo, gitCwd(repo), [
		'rev-parse',
		'--verify',
		'--quiet',
		'--end-of-options',
		`${revision}^{commit}`
	]);
	if (resolved.ok) {
		const id = parseCommitId(firstLine(resolved.value.stdout));
		if (id.ok) return ok(id.value);
	} else if (resolved.error.kind !== 'GitFailed' && resolved.error.kind !== 'BadRevision') {
		return resolved;
	}
	const head = await headCommit(repo);
	if (!head.ok) return head;
	const anyRef = await gitIn(repo, gitCwd(repo), [
		'for-each-ref',
		'--count=1',
		'--format=%(refname)'
	]);
	const empty = head.value === undefined && anyRef.ok && anyRef.value.stdout.length === 0;
	return err({
		kind: empty ? 'NoCommitsYet' : 'UnknownRevision',
		repository: repo.commonDir,
		revision
	});
}

/**
 * The tree of a commit, as the commit names it. Read from the commit itself, so
 * a partial clone that never downloaded the tree still gives its id, and the
 * copy into the store is what finds it missing.
 */
export async function treeOf(
	repo: LocalRepository,
	commit: CommitId
): Promise<Result<TreeId, GitSourceError>> {
	const read = await gitIn(repo, gitCwd(repo), ['cat-file', 'commit', commit]);
	if (!read.ok) return read;
	const id = parseTreeId(/^tree ([0-9a-f]+)$/.exec(firstLine(read.value.stdout))?.[1] ?? '');
	return id.ok
		? ok(id.value)
		: err({ kind: 'MissingObject', object: commit, stderr: read.value.stderr });
}

/** The commits a shallow clone has without their parents. */
async function shallowBoundary(repo: LocalRepository): Promise<ReadonlySet<string>> {
	if (!repo.shallow) return new Set();
	const text = await readFile(join(repo.commonDir, 'shallow'), 'utf8').catch(() => '');
	return new Set(text.split('\n').filter((line) => line !== ''));
}

/**
 * A commit's first parent, or undefined for a root commit. In a shallow clone, a
 * commit whose parents were not downloaded is `ShallowHistory`, not a root.
 */
export async function firstParent(
	repo: LocalRepository,
	commit: CommitId
): Promise<Result<CommitId | undefined, GitSourceError>> {
	const listed = await gitIn(repo, gitCwd(repo), [
		'rev-list',
		'--parents',
		'-n',
		'1',
		'--end-of-options',
		commit
	]);
	if (!listed.ok) return listed;
	const [, parent] = firstLine(listed.value.stdout).split(' ');
	if (parent === undefined) {
		const boundary = await shallowBoundary(repo);
		return boundary.has(commit)
			? err({ kind: 'ShallowHistory', repository: repo.commonDir, commit })
			: ok(undefined);
	}
	const id = parseCommitId(parent);
	return id.ok
		? ok(id.value)
		: err({ kind: 'MissingObject', object: parent, stderr: listed.value.stderr });
}

/** The merge base of two commits, which a range compares from. */
export async function mergeBase(
	repo: LocalRepository,
	from: { readonly revision: Revision; readonly commit: CommitId },
	to: { readonly revision: Revision; readonly commit: CommitId }
): Promise<Result<CommitId, GitSourceError>> {
	const base = await gitIn(repo, gitCwd(repo), [
		'merge-base',
		'--end-of-options',
		from.commit,
		to.commit
	]);
	if (base.ok) {
		const id = parseCommitId(firstLine(base.value.stdout));
		if (id.ok) return ok(id.value);
	} else if (base.error.kind !== 'GitFailed') {
		return base;
	}
	return repo.shallow
		? err({ kind: 'ShallowHistory', repository: repo.commonDir, commit: to.commit })
		: err({
				kind: 'NoCommonHistory',
				repository: repo.commonDir,
				from: from.revision,
				to: to.revision
			});
}
