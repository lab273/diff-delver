/**
 * The no-argument start (DESIGN 3): what a person most plausibly wants to review
 * in a directory, decided from the repository alone.
 *
 * 1. Uncommitted changes, if there are any.
 * 2. Otherwise the current branch compared with the main branch, from their
 *    merge base, as its pull request would show it. The main branch is the
 *    remote's default branch (`origin/HEAD`, or the one remote that has one);
 *    failing that, whichever of the reviewer's `init.defaultBranch`, `main`,
 *    `master` and `trunk` exists, preferring `origin/<name>` to a local branch.
 * 3. On the main branch itself, the commits not yet pushed: the branch
 *    compared with its upstream.
 *
 * When uncommitted changes win, the branch comparison is offered as well. When
 * more than one main branch is plausible (`main` and `master` both exist) the
 * candidates are returned for the start page's choice. When nothing is plausible, the reason
 * is given with the last commit as a candidate.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseBranchRef, type BranchRef } from '#lib/core/history/branch-ref.tiny.ts';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { fileCountOf, type FileCount } from '#lib/core/file-count.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { HEAD, parseRevision, type Revision } from '#lib/core/revision.tiny.ts';
import {
	describeGitSourceWithSize,
	formatGitSourceSpec,
	shortRevisionName,
	WORKING_TREE,
	type GitSourceSpec
} from '#lib/core/sources/git-source-spec.ts';
import type { SourceText } from '#lib/core/sources/source-text.tiny.ts';
import type { GitSourceError } from './git-source-error.ts';
import {
	gitCwd,
	gitIn,
	locateRepository,
	type LocalRepository,
	type RepositoryOptions
} from './local-repository.ts';
import { firstParent, headCommit, resolveCommit } from './resolve.ts';
import { workingTreeStatus } from './working-tree-status.ts';

/** One thing that could be reviewed, for the start page's choice. */
export interface SourceCandidate {
	readonly spec: GitSourceSpec;
	/** In plain words, with its size: "Uncommitted changes (12 files)". */
	readonly description: ReviewerMessage;
	/**
	 * How many files it changes, as a size hint. Absent when it could not be
	 * counted without downloading: a partial clone that lacks the trees.
	 */
	readonly files: FileCount | undefined;
}

export type SourceSuggestion =
	/** One clear choice; `others` are worth offering beside it. */
	| {
			readonly kind: 'one';
			readonly candidate: SourceCandidate;
			readonly others: readonly SourceCandidate[];
	  }
	/** Several are equally plausible: let the person choose. */
	| { readonly kind: 'choose'; readonly candidates: readonly SourceCandidate[] }
	/** Nothing obvious to review, and why, with whatever could still be opened. */
	| {
			readonly kind: 'nothing';
			readonly reason: ReviewerMessage;
			readonly candidates: readonly SourceCandidate[];
	  };

export interface SuggestedSource {
	readonly repository: LocalRepository;
	readonly suggestion: SourceSuggestion;
}

function revision(text: string): Revision {
	const parsed = parseRevision(text);
	if (!parsed.ok) throw new Error(`Not a revision: ${text}`);
	return parsed.value;
}

function candidate(spec: GitSourceSpec, files: FileCount | undefined): SourceCandidate {
	return { spec, files, description: describeGitSourceWithSize(spec, files) };
}

/** Every branch and remote-tracking ref, and where each remote's HEAD points. */
async function refs(
	repo: LocalRepository
): Promise<
	Result<{ names: ReadonlySet<string>; remoteHeads: ReadonlyMap<string, string> }, GitSourceError>
> {
	const listed = await gitIn(repo, gitCwd(repo), [
		'for-each-ref',
		'--format=%(refname)%00%(symref)',
		'refs/heads/',
		'refs/remotes/'
	]);
	if (!listed.ok) return listed;
	const names = new Set<string>();
	const remoteHeads = new Map<string, string>();
	for (const line of listed.value.stdout.toString('utf8').split('\n')) {
		const [name = '', target = ''] = line.split('\0');
		if (name === '') continue;
		names.add(name);
		const remote = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(name)?.[1];
		if (remote !== undefined && target !== '') remoteHeads.set(remote, target);
	}
	return ok({ names, remoteHeads });
}

interface Branches {
	/** The full names of the branches that could be the main one; more than one means it is unclear. */
	readonly mains: readonly string[];
	/** Every branch and remote-tracking branch, local ones first, for an example to give. */
	readonly all: readonly string[];
}

async function mainBranches(repo: LocalRepository): Promise<Result<Branches, GitSourceError>> {
	const known = await refs(repo);
	if (!known.ok) return known;
	const { names, remoteHeads } = known.value;
	const all = [...names]
		.filter((name) => !name.endsWith('/HEAD'))
		.toSorted((a, b) => Number(b.startsWith('refs/heads/')) - Number(a.startsWith('refs/heads/')));
	const branches = (mains: readonly string[]): Result<Branches, GitSourceError> =>
		ok({ mains, all });
	const heads = [...remoteHeads.entries()].filter(([, target]) => names.has(target));
	const origin = heads.find(([remote]) => remote === 'origin');
	if (origin !== undefined) return branches([origin[1]]);
	if (heads.length > 0) return branches(heads.map(([, target]) => target));
	const configured = await gitIn(repo, gitCwd(repo), ['config', '--get', 'init.defaultBranch']);
	const preferred = configured.ok ? [configured.value.stdout.toString('utf8').trim()] : [];
	const found: string[] = [];
	for (const name of new Set([...preferred, 'main', 'master', 'trunk'])) {
		if (name === '') continue;
		const ref = [`refs/remotes/origin/${name}`, `refs/heads/${name}`].find((r) => names.has(r));
		if (ref !== undefined) found.push(ref);
	}
	return branches(found);
}

/**
 * The branch other branches are compared with, as the no-argument start finds
 * it, or undefined when none can be told. When more than one is plausible,
 * the one the start would list first.
 */
export async function mainBranch(
	repo: LocalRepository
): Promise<Result<BranchRef | undefined, GitSourceError>> {
	const branches = await mainBranches(repo);
	if (!branches.ok) return branches;
	for (const name of branches.value.mains) {
		const ref = parseBranchRef(name);
		if (ref.ok) return ok(ref.value);
	}
	return ok(undefined);
}

/**
 * How many files differ between two commits, renames counted once. Rename
 * detection reads file contents, so in a partial clone that lacks them the
 * files are counted without it, a rename as two; one that lacks the trees as
 * well cannot be counted, which is undefined. git never fetches here.
 */
async function filesChanged(
	repo: LocalRepository,
	base: CommitId | undefined,
	head: CommitId
): Promise<Result<FileCount | undefined, GitSourceError>> {
	const ends = base === undefined ? ['--root', '--no-commit-id', head] : [base, head];
	for (const renames of [['-M'], ['--no-renames']]) {
		const listed = await gitIn(repo, gitCwd(repo), [
			'diff-tree',
			'-r',
			'-z',
			'--name-only',
			...renames,
			...ends
		]);
		if (!listed.ok) {
			if (listed.error.kind === 'MissingObject') continue;
			return listed;
		}
		const names = listed.value.stdout
			.toString('latin1')
			.split('\0')
			.filter((n) => n !== '');
		return ok(fileCountOf(names.length));
	}
	return ok(undefined);
}

/** The merge base of two commits, or undefined when they share no history (or it was not downloaded). */
async function mergeBaseOf(
	repo: LocalRepository,
	a: CommitId,
	b: CommitId
): Promise<Result<CommitId | undefined, GitSourceError>> {
	const base = await gitIn(repo, gitCwd(repo), ['merge-base', a, b]);
	if (!base.ok) return base.error.kind === 'GitFailed' ? ok(undefined) : base;
	const id = parseCommitId(base.value.stdout.toString('utf8').trim());
	return ok(id.ok ? id.value : undefined);
}

/** The current branch compared with `from`, if it has commits `from` lacks. */
async function comparison(
	repo: LocalRepository,
	from: string,
	to: Revision,
	head: CommitId
): Promise<Result<SourceCandidate | undefined, GitSourceError>> {
	const fromCommit = await resolveCommit(repo, revision(from));
	if (!fromCommit.ok) return ok(undefined);
	const base = await mergeBaseOf(repo, fromCommit.value, head);
	if (!base.ok) return base;
	if (base.value === undefined || base.value === head) return ok(undefined);
	const files = await filesChanged(repo, base.value, head);
	if (!files.ok) return files;
	return ok(candidate({ kind: 'range', from: revision(from), to }, files.value));
}

/** The branch HEAD is on, as its full name, or undefined when HEAD is detached or unborn. */
async function currentBranch(repo: LocalRepository): Promise<string | undefined> {
	const branch = await gitIn(repo, gitCwd(repo), ['symbolic-ref', '--quiet', 'HEAD']);
	return branch.ok ? branch.value.stdout.toString('utf8').trim() : undefined;
}

async function lastCommit(
	repo: LocalRepository,
	head: CommitId
): Promise<Result<SourceCandidate, GitSourceError>> {
	const parent = await firstParent(repo, head);
	const files = await filesChanged(repo, parent.ok ? parent.value : undefined, head);
	if (!files.ok) return files;
	return ok(candidate({ kind: 'commit', revision: HEAD }, files.value));
}

/** The branch comparisons worth offering: with the main branch, or with the upstream on the main branch itself. */
async function branchCandidates(
	repo: LocalRepository,
	head: CommitId
): Promise<Result<{ candidates: readonly SourceCandidate[]; branches: Branches }, GitSourceError>> {
	const branches = await mainBranches(repo);
	if (!branches.ok) return branches;
	const branch = await currentBranch(repo);
	const to = branch === undefined ? HEAD : revision(branch);
	const candidates: SourceCandidate[] = [];
	for (const main of branches.value.mains) {
		if (main === branch) continue;
		const found = await comparison(repo, main, to, head);
		if (!found.ok) return found;
		if (found.value !== undefined) candidates.push(found.value);
	}
	if (candidates.length === 0 && branch !== undefined) {
		const upstream = await gitIn(repo, gitCwd(repo), [
			'rev-parse',
			'--symbolic-full-name',
			'--verify',
			'--quiet',
			`${branch}@{upstream}`
		]);
		if (upstream.ok) {
			const found = await comparison(repo, upstream.value.stdout.toString('utf8').trim(), to, head);
			if (!found.ok) return found;
			if (found.value !== undefined) candidates.push(found.value);
		}
	}
	return ok({ candidates, branches: branches.value });
}

/** Why there is nothing obvious to review, in plain words. */
function nothingReason(branch: string | undefined, branches: Branches): ReviewerMessage {
	const { mains } = branches;
	const name =
		branch === undefined ? 'The checked-out commit' : shortRevisionName(revision(branch));
	if (mains.length === 0) {
		// An example made of branches this repository has.
		const other = branches.all.find((ref) => ref !== branch);
		const to = branch === undefined ? 'HEAD' : name;
		const example =
			other === undefined
				? 'name two revisions to compare, written as from...to'
				: `name two branches to compare, such as ${shortRevisionName(revision(other))}...${to}`;
		return reviewerMessage(
			`There are no uncommitted changes, and diff delver could not tell which branch is the main one. Choose what to review below, or ${example}.`
		);
	}
	const main = shortRevisionName(revision(mains[0] ?? 'main'));
	if (branch !== undefined && mains.includes(branch)) {
		return reviewerMessage(
			`There is nothing new to review: there are no uncommitted changes, and you are on ${main}, the main branch, with nothing that is not pushed. You can still open the last commit.`
		);
	}
	return reviewerMessage(
		`There is nothing new to review: there are no uncommitted changes, and ${name} has no commits that ${main} does not have. You can still open the last commit.`
	);
}

/** What a person most plausibly wants to review in the repository at `directory`. */
export async function suggestSource(
	directory: AbsolutePath,
	options: RepositoryOptions = {}
): Promise<Result<SuggestedSource, GitSourceError>> {
	const repository = await locateRepository(directory, options);
	if (!repository.ok) return repository;
	const repo = repository.value;
	const done = (suggestion: SourceSuggestion): Result<SuggestedSource, GitSourceError> =>
		ok({ repository: repo, suggestion });

	let uncommitted: SourceCandidate | undefined;
	if (repo.workTree !== undefined) {
		const status = await workingTreeStatus(repo);
		if (!status.ok) return status;
		// git status's entries, which can differ a little from the snapshot's diff: a
		// rename not yet staged is a deletion and an untracked file, two entries,
		// where the diff finds one rename; a change staged and then undone in the
		// working tree is an entry where the diff shows nothing. Matching the diff
		// would mean reading file contents, too costly for a hint. It is never zero
		// when the diff has changes, which is what decides the suggestion.
		const count = status.value.entries.length;
		if (count > 0) uncommitted = candidate(WORKING_TREE, fileCountOf(count));
	}
	const head = await headCommit(repo);
	if (!head.ok) return head;
	if (head.value === undefined) {
		const empty =
			repo.workTree === undefined
				? 'This bare repository has no commits yet, so there is nothing to review. Push commits to it, or run diff delver in a clone of it that has work in it.'
				: 'This repository has no commits and no files yet, so there is nothing to review. Add some files, then run diff delver again.';
		return uncommitted === undefined
			? done({ kind: 'nothing', reason: reviewerMessage(empty), candidates: [] })
			: done({ kind: 'one', candidate: uncommitted, others: [] });
	}
	const branches = await branchCandidates(repo, head.value);
	if (!branches.ok) return branches;
	const { candidates } = branches.value;
	if (uncommitted !== undefined)
		return done({ kind: 'one', candidate: uncommitted, others: candidates });
	const [only, ...rest] = candidates;
	if (only !== undefined && rest.length === 0)
		return done({ kind: 'one', candidate: only, others: [] });
	if (only !== undefined) return done({ kind: 'choose', candidates });
	const last = await lastCommit(repo, head.value);
	if (!last.ok) return last;
	return done({
		kind: 'nothing',
		reason: nothingReason(await currentBranch(repo), branches.value.branches),
		candidates: [last.value]
	});
}

/** The candidate's source in its written form, for a link or a command line. */
export function candidateSourceText(candidate: SourceCandidate): SourceText {
	return formatGitSourceSpec(candidate.spec);
}
