/**
 * Turning a local git source into a snapshot (DESIGN 3.1, the first two rows).
 *
 * Nothing is written to the reviewed repository. A commit or range only reads
 * it: its trees are copied into the store from its object directory, borrowed
 * read-only. The working tree and the index are turned into trees the way
 * `git add --all` and `git write-tree` would, but against a private copy of the
 * index (`scratch-index.ts`) and with `GIT_OBJECT_DIRECTORY` pointing at the
 * store, so every object git writes lands in the store. The repository's own
 * objects are not visible to git while it writes, because git touches an
 * existing object it is asked to write again; the blobs the index names are
 * copied into the store first instead, so git can still read them (it checks the
 * committed file's line endings, for instance). `git add` runs in the working
 * tree with the reviewer's config, so their ignore rules, line-ending settings
 * and filters apply exactly as when they commit, with hooks and fsmonitor off.
 *
 * One known exception: a filter that itself writes into the repository, such as
 * Git LFS's clean filter storing a changed file's content under `.git/lfs`,
 * still does so, as it would on `git add`.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseBlobId, type BlobId } from '#lib/core/blob-id.tiny.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import { escapedRepoPath, repoPathFromBytes } from '#lib/core/path-bytes.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import { repositoryNameOf } from '#lib/core/repository-name.tiny.ts';
import { EMPTY_TREE } from '#lib/core/object-format.ts';
import { objectCountOf, type ObjectCount } from '#lib/core/object-count.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import {
	describeAddRefusals,
	parseAddRefusals,
	type AddRefusal
} from '#lib/core/sources/git-add-refusal.ts';
import type { GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import type { SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import { runGit } from '../../git/run-git.ts';
import {
	copyObjects,
	copyTrees,
	ensureStore,
	takeSnapshot,
	type PreparedTrees,
	type Snapshot,
	type StoreWriter
} from '../../store/index.ts';
import type { GitSourceError } from './git-source-error.ts';
import { gitIn, type LocalRepository } from './local-repository.ts';
import { firstParent, headCommit, mergeBase, resolveCommit, treeOf } from './resolve.ts';
import {
	removeStaleScratchIndexes,
	scratchSettings,
	withScratchIndex,
	type ScratchIndex
} from './scratch-index.ts';
import { sourceIdentity } from './source-identity.ts';

export interface GitSnapshot {
	readonly snapshot: Snapshot;
	/**
	 * The source's identity just before the snapshot was taken. Compare it with a
	 * later `sourceIdentity` to notice a change; taken first, it never hides one.
	 */
	readonly identity: SourceIdentity;
	/** The commit the old side is, or undefined for the empty tree. */
	readonly baseCommit: CommitId | undefined;
	/** The commit the new side is, or undefined for the working tree or the index. */
	readonly headCommit: CommitId | undefined;
	/** How many objects were copied into the store. */
	readonly copied: ObjectCount;
	/** Files of the working tree that could not be included, one sentence each, such as an unreadable file. */
	readonly leftOut: readonly ReviewerMessage[];
}

interface Sides {
	readonly trees: PreparedTrees;
	readonly baseCommit: CommitId | undefined;
	readonly headCommit: CommitId | undefined;
	readonly leftOut: readonly ReviewerMessage[];
	/** Objects copied into the store while the trees were worked out. */
	readonly copied: ObjectCount;
}

async function treeOrEmpty(
	repo: LocalRepository,
	commit: CommitId | undefined
): Promise<Result<TreeId, GitSourceError>> {
	return commit === undefined ? ok(EMPTY_TREE[repo.objectFormat]) : treeOf(repo, commit);
}

async function commitSides(
	repo: LocalRepository,
	base: CommitId | undefined,
	head: CommitId
): Promise<Result<Sides, GitSourceError>> {
	const baseTree = await treeOrEmpty(repo, base);
	if (!baseTree.ok) return baseTree;
	const headTree = await treeOf(repo, head);
	if (!headTree.ok) return headTree;
	return ok({
		trees: { base: baseTree.value, head: headTree.value, copyFrom: repo.objects },
		baseCommit: base,
		headCommit: head,
		leftOut: [],
		copied: objectCountOf(0)
	});
}

/** The environment for git commands that write into the store with the private index. */
function writing(scratch: ScratchIndex, writer: StoreWriter): Record<string, string> {
	return {
		GIT_INDEX_FILE: scratch.index,
		GIT_OBJECT_DIRECTORY: writer.objects,
		GIT_NO_LAZY_FETCH: '1'
	};
}

/** The conflicted files of the private index, sorted, from a merge that is not finished. */
async function unmergedPaths(
	scratch: ScratchIndex
): Promise<Result<readonly RepoPath[], GitSourceError>> {
	const listed = await runGit({
		cwd: scratch.gitDir,
		args: ['ls-files', '--unmerged', '-z'],
		env: { GIT_INDEX_FILE: scratch.index }
	});
	if (!listed.ok) return listed;
	const paths = new Set<RepoPath>();
	for (const record of nulSeparated(listed.value.stdout)) {
		const tab = record.indexOf(0x09);
		const path = repoPathFromBytes(record.subarray(tab + 1));
		if (tab !== -1 && path.ok) paths.add(path.value);
	}
	return ok([...paths].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The index as a tree, or `UnresolvedConflict` when a merge left files without a staged version. */
async function stagedTree(
	repo: LocalRepository,
	scratch: ScratchIndex,
	writer: StoreWriter
): Promise<Result<TreeId, GitSourceError>> {
	const unmerged = await unmergedPaths(scratch);
	if (!unmerged.ok) return unmerged;
	if (unmerged.value.length > 0) {
		return err({ kind: 'UnresolvedConflict', repository: repo.commonDir, paths: unmerged.value });
	}
	return writeTree(scratch, writer);
}

/** Writes the private index as a tree into the store. */
async function writeTree(
	scratch: ScratchIndex,
	writer: StoreWriter
): Promise<Result<TreeId, GitSourceError>> {
	const written = await runGit({
		cwd: scratch.gitDir,
		args: [...scratchSettings(scratch), 'write-tree', '--missing-ok'],
		env: writing(scratch, writer)
	});
	if (!written.ok) return written;
	const tree = parseTreeId(written.value.stdout.toString('utf8').trim());
	return tree.ok
		? ok(tree.value)
		: err({
				kind: 'GitFailed',
				args: ['write-tree'],
				exitCode: undefined,
				stderr: written.value.stderr
			});
}

/** The blobs the private index names, which `git add` may read. Submodule entries name commits, not blobs. */
async function indexBlobs(
	scratch: ScratchIndex
): Promise<Result<readonly BlobId[], GitSourceError>> {
	const listed = await runGit({
		cwd: scratch.gitDir,
		args: ['ls-files', '--stage', '-z'],
		env: { GIT_INDEX_FILE: scratch.index }
	});
	if (!listed.ok) return listed;
	const blobs = new Set<BlobId>();
	for (const record of listed.value.stdout.toString('latin1').split('\0')) {
		const [mode, id] = record.split(' ');
		const blob = parseBlobId(id ?? '');
		if (mode !== undefined && mode !== '160000' && blob.ok) blobs.add(blob.value);
	}
	return ok([...blobs]);
}

/** How many files may vanish while `git add` runs before diff delver gives up. */
const MAX_VANISHED = 50;

/** What git says when a file it listed is gone before it can read it. */
const VANISHED = /^fatal: unable to stat '(.*)': No such file or directory$/m;

/**
 * `git add --all` into the private index. A file deleted while git runs, such as
 * an editor's or a build's temporary file, makes git stop; it is tried again
 * with that path left out, and the paths left out are returned.
 */
async function addAll(
	repo: LocalRepository,
	workTree: AbsolutePath,
	scratch: ScratchIndex,
	writer: StoreWriter
): Promise<{
	readonly added: Awaited<ReturnType<typeof gitIn>>;
	readonly vanished: readonly RepoPath[];
}> {
	const vanished: RepoPath[] = [];
	for (;;) {
		const added = await gitIn(
			repo,
			workTree,
			[
				...scratchSettings(scratch),
				'add',
				'--all',
				'--ignore-errors',
				'--',
				':/',
				...vanished.map((gone) => `:(top,exclude,literal)${gone}`)
			],
			{ env: writing(scratch, writer) }
		);
		const named =
			added.ok || added.error.kind !== 'GitFailed'
				? undefined
				: parseRepoPath(VANISHED.exec(added.error.stderr)?.[1] ?? '');
		const gone = named?.ok === true ? named.value : undefined;
		if (gone === undefined || vanished.includes(gone) || vanished.length === MAX_VANISHED) {
			return { added, vanished };
		}
		vanished.push(gone);
	}
}

/** The working tree as `git add --all` would stage it, written into the store. */
async function workingTreeTree(
	repo: LocalRepository,
	workTree: AbsolutePath,
	scratch: ScratchIndex,
	writer: StoreWriter
): Promise<
	Result<{ tree: TreeId; leftOut: readonly ReviewerMessage[]; copied: ObjectCount }, GitSourceError>
> {
	const blobs = await indexBlobs(scratch);
	if (!blobs.ok) return blobs;
	const copied = await copyObjects(writer, blobs.value, repo.objects);
	if (!copied.ok) return copied;
	const { added, vanished } = await addAll(repo, workTree, scratch, writer);
	const leftOut: ReviewerMessage[] = vanished.map((gone) =>
		reviewerMessage(
			`Not included: ${escapedRepoPath(gone)}, which was deleted while the snapshot was being taken. Refresh to include its change.`
		)
	);
	// With --ignore-errors, git adds everything it can and exits 1 if some file could not be.
	if (!added.ok && (added.error.kind !== 'GitFailed' || added.error.exitCode !== 1)) return added;
	const refused = parseAddRefusals(stderrOf(added));
	const changing = await settle(repo, workTree, scratch, writer, refused.refusals);
	if (!changing.ok) return changing;
	leftOut.push(
		...describeAddRefusals({
			refusals: changing.value.refusals,
			unrecognised: refused.unrecognised || changing.value.unrecognised
		})
	);
	for (const path of changing.value.changing) {
		leftOut.push(
			reviewerMessage(
				`${escapedRepoPath(path)} kept changing while the snapshot was being taken, so it may hold part of an edit. Refresh to get its final version.`
			)
		);
	}
	const tree = await writeTree(scratch, writer);
	return tree.ok ? ok({ tree: tree.value, leftOut, copied: copied.value }) : tree;
}

/** How many times files that changed during `git add` are added again. */
const SETTLE_ROUNDS = 3;

/** What git printed to stderr, whether it succeeded or failed. */
function stderrOf(run: Awaited<ReturnType<typeof gitIn>>): string {
	if (run.ok) return run.value.stderr;
	return 'stderr' in run.error ? run.error.stderr : '';
}

/** The records of NUL-separated output, as bytes. */
function nulSeparated(output: Buffer): Buffer[] {
	const records: Buffer[] = [];
	for (let at = 0; at < output.length;) {
		const end = output.indexOf(0, at);
		const stop = end === -1 ? output.length : end;
		if (stop > at) records.push(output.subarray(at, stop));
		at = stop + 1;
	}
	return records;
}

interface Settled {
	/** Paths still changing after the last round. */
	readonly changing: readonly RepoPath[];
	/** Every file git refused, in the first `git add` or while settling. */
	readonly refusals: readonly AddRefusal[];
	/** git refused a file for a reason not recognised. */
	readonly unrecognised: boolean;
}

/**
 * Adds again the files that changed while `git add` read them, until the private
 * index matches the working tree. git reads as many bytes as the file had when it
 * looked at it, so a file replaced in between can be caught cut short; `git
 * diff-files` finds every file whose content no longer matches what was stored.
 * A file git refused differs too, since the index keeps its old version; it is
 * not added again, and not reported as changing.
 */
async function settle(
	repo: LocalRepository,
	workTree: AbsolutePath,
	scratch: ScratchIndex,
	writer: StoreWriter,
	refusedFirst: readonly AddRefusal[]
): Promise<Result<Settled, GitSourceError>> {
	const refusals = new Map(refusedFirst.map((refusal) => [String(refusal.path), refusal]));
	let unrecognised = false;
	for (let round = 0; ; round += 1) {
		const differing = await gitIn(
			repo,
			workTree,
			[...scratchSettings(scratch), 'diff-files', '--name-only', '-z', '--ignore-submodules=dirty'],
			{ env: writing(scratch, writer) }
		);
		if (!differing.ok) return differing;
		// Compared as text: git prints a refused path to stderr, decoded the same way.
		const paths = nulSeparated(differing.value.stdout).filter(
			(path) => !refusals.has(path.toString('utf8'))
		);
		const settled = (changing: readonly Buffer[]): Result<Settled, GitSourceError> =>
			ok({
				changing: changing.flatMap((path) => {
					const parsed = repoPathFromBytes(path);
					return parsed.ok ? [parsed.value] : [];
				}),
				refusals: [...refusals.values()].toSorted((a, b) =>
					a.path < b.path ? -1 : a.path > b.path ? 1 : 0
				),
				unrecognised
			});
		if (paths.length === 0) return settled([]);
		if (round === SETTLE_ROUNDS) return settled(paths);
		const again = await gitIn(
			repo,
			workTree,
			[
				...scratchSettings(scratch),
				'add',
				'--all',
				'--ignore-errors',
				'--pathspec-from-file=-',
				'--pathspec-file-nul'
			],
			{
				env: { ...writing(scratch, writer), GIT_LITERAL_PATHSPECS: '1' },
				input: Buffer.concat(paths.flatMap((path) => [path, Buffer.from([0])]))
			}
		);
		// A file deleted meanwhile is found again next round; one git refuses now is left out.
		if (!again.ok && again.error.kind !== 'GitFailed') return again;
		const refusedNow = parseAddRefusals(stderrOf(again));
		for (const refusal of refusedNow.refusals) refusals.set(String(refusal.path), refusal);
		unrecognised ||= refusedNow.unrecognised;
	}
}

async function prepareSides(
	repo: LocalRepository,
	spec: GitSourceSpec,
	writer: StoreWriter
): Promise<Result<Sides, GitSourceError>> {
	switch (spec.kind) {
		case 'commit': {
			const commit = await resolveCommit(repo, spec.revision);
			if (!commit.ok) return commit;
			const parent = await firstParent(repo, commit.value);
			if (!parent.ok) return parent;
			return commitSides(repo, parent.value, commit.value);
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
			return commitSides(repo, base.value, to.value);
		}
		case 'staged':
		case 'working-tree': {
			const workTree = repo.workTree;
			if (workTree === undefined) {
				return err({ kind: 'NoWorkingTree', repository: repo.commonDir, source: spec.kind });
			}
			const head = await headCommit(repo);
			if (!head.ok) return head;
			const base = await treeOrEmpty(repo, head.value);
			if (!base.ok) return base;
			// The base side is needed anyway, and expanding a sparse index reads its trees.
			const copied = await copyTrees(writer, [base.value], repo.objects);
			if (!copied.ok) return copied;
			return withScratchIndex(
				repo,
				writer.objects,
				async (scratch): Promise<Result<Sides, GitSourceError>> => {
					const written =
						spec.kind === 'staged'
							? await stagedTree(repo, scratch, writer).then((tree) =>
									tree.ok ? ok({ tree: tree.value, leftOut: [], copied: objectCountOf(0) }) : tree
								)
							: await workingTreeTree(repo, workTree, scratch, writer);
					if (!written.ok) return written;
					return ok({
						trees: { base: base.value, head: written.value.tree, copyFrom: repo.objects },
						baseCommit: head.value,
						headCommit: undefined,
						leftOut: written.value.leftOut,
						copied: objectCountOf(copied.value + written.value.copied)
					});
				}
			);
		}
	}
}

/**
 * Takes a snapshot of the source in the repository's store in the data
 * directory, making the store if this is the repository's first.
 */
export async function snapshotGitSource(
	dataDirectory: AbsolutePath,
	repo: LocalRepository,
	spec: GitSourceSpec
): Promise<Result<GitSnapshot, GitSourceError>> {
	const identity = await sourceIdentity(repo, spec);
	if (!identity.ok) return identity;
	const store = await ensureStore(
		dataDirectory,
		repo.storeId,
		repo.objectFormat,
		repositoryNameOf(repo.commonDir)
	);
	if (!store.ok) return store;
	await removeStaleScratchIndexes();
	let sides: Sides | undefined;
	const taken = await takeSnapshot(store.value, async (writer) => {
		const prepared = await prepareSides(repo, spec, writer);
		if (!prepared.ok) return prepared;
		sides = prepared.value;
		return ok(prepared.value.trees);
	});
	if (!taken.ok) {
		return taken.error.kind === 'MissingObject' && repo.partialClone
			? err({ kind: 'PartialCloneMissing', repository: repo.commonDir })
			: taken;
	}
	return ok({
		snapshot: taken.value.snapshot,
		identity: identity.value,
		baseCommit: sides?.baseCommit,
		headCommit: sides?.headCommit,
		copied: objectCountOf(taken.value.copied + (sides?.copied ?? 0)),
		leftOut: sides?.leftOut ?? []
	});
}
