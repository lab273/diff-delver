/**
 * Whether a source can be read and has anything to review, without taking a
 * snapshot: for the page that says why a source could not be opened, which may
 * be reloaded any number of times. It resolves the source as a snapshot would,
 * so a revision git does not know fails the same way, and then asks git for the
 * changed paths alone, never their contents, writing nothing anywhere.
 *
 * - A commit or a range: whether its two trees differ (`diff-tree --name-only`).
 * - Staged: whether the index differs from HEAD (`diff-index --cached`).
 * - Working tree: whether `git status` lists anything, untracked files included.
 *
 * It can differ from a snapshot's diff only where `git status` and the snapshot
 * do (see `suggest-source.ts`): a file git would refuse to add is listed here.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import type { GitSourceError } from './git-source-error.ts';
import { gitCwd, gitIn, sharedIndexFiles, type LocalRepository } from './local-repository.ts';
import { firstParent, headCommit, mergeBase, resolveCommit } from './resolve.ts';
import { withScratchIndex } from './scratch-index.ts';
import { workingTreeStatus } from './working-tree-status.ts';

/** Whether git listed any path. */
function listedAny(stdout: Buffer): boolean {
	return stdout.some((byte) => byte !== 0);
}

/** Whether two commits' trees differ, the first absent for a root commit. */
async function commitsDiffer(
	repo: LocalRepository,
	base: CommitId | undefined,
	head: CommitId
): Promise<Result<boolean, GitSourceError>> {
	// A root commit is compared with nothing; its own id, which git would print first, is left out.
	const root = base === undefined ? ['--root', '--no-commit-id'] : [];
	const commits = base === undefined ? [head] : [base, head];
	const listed = await gitIn(repo, gitCwd(repo), [
		'diff-tree',
		'-r',
		'-z',
		'--name-only',
		'--no-renames',
		...root,
		'--end-of-options',
		...commits
	]);
	return listed.ok ? ok(listedAny(listed.value.stdout)) : listed;
}

/** Whether the index differs from HEAD, or holds anything when there is no commit yet. */
async function indexDiffers(
	repo: LocalRepository,
	workTree: AbsolutePath
): Promise<Result<boolean, GitSourceError>> {
	const head = await headCommit(repo);
	if (!head.ok) return head;
	const args =
		head.value === undefined
			? ['ls-files', '-z', '--cached']
			: ['diff-index', '--cached', '-z', '--name-only', '--no-renames', head.value];
	const run = (index: string | undefined) =>
		gitIn(repo, workTree, ['-c', 'core.fsmonitor=false', ...args], {
			env: index === undefined ? {} : { GIT_INDEX_FILE: index }
		});
	const listed =
		(await sharedIndexFiles(repo)).length === 0
			? await run(undefined)
			: await withScratchIndex(repo, undefined, (scratch) => run(scratch.index));
	return listed.ok ? ok(listedAny(listed.value.stdout)) : listed;
}

/** Whether the source has changes to review; an error when it cannot be read, as a snapshot would fail. */
export async function sourceHasChanges(
	repo: LocalRepository,
	spec: GitSourceSpec
): Promise<Result<boolean, GitSourceError>> {
	switch (spec.kind) {
		case 'commit': {
			const commit = await resolveCommit(repo, spec.revision);
			if (!commit.ok) return commit;
			const parent = await firstParent(repo, commit.value);
			if (!parent.ok) return parent;
			return commitsDiffer(repo, parent.value, commit.value);
		}
		case 'range': {
			const from = await resolveCommit(repo, spec.from);
			if (!from.ok) return from;
			const to = await resolveCommit(repo, spec.to);
			if (!to.ok) return to;
			const base = await mergeBase(
				repo,
				{ revision: spec.from, commit: from.value },
				{ revision: spec.to, commit: to.value }
			);
			if (!base.ok) return base;
			return commitsDiffer(repo, base.value, to.value);
		}
		case 'staged': {
			const workTree = repo.workTree;
			if (workTree === undefined) {
				return {
					ok: false,
					error: { kind: 'NoWorkingTree', repository: repo.commonDir, source: 'staged' }
				};
			}
			return indexDiffers(repo, workTree);
		}
		case 'working-tree': {
			const status = await workingTreeStatus(repo);
			return status.ok ? ok(status.value.entries.length > 0) : status;
		}
	}
}
