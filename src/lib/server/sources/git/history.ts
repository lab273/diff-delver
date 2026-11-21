/**
 * A repository's history, for choosing commits or a branch to review (DESIGN
 * 3.1): its branches, a branch's commits a page at a time with their sizes, the
 * size of the diff a run of them makes, and when the repository last fetched.
 *
 * Everything here only reads the repository, through `gitIn`, and never the
 * network. Nothing reads the whole history: branches are listed by one
 * `for-each-ref`, and commits come a page at a time from one `git log` that
 * walks only as far as the page, with each commit's size from the same call.
 */
import { stat } from 'node:fs/promises';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { fileCountOf, type FileCount } from '#lib/core/file-count.tiny.ts';
import { lineCountOf, type LineCount } from '#lib/core/line-count.tiny.ts';
import { EMPTY_TREE } from '#lib/core/object-format.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseRevision } from '#lib/core/revision.tiny.ts';
import { parseTimestamp, type Timestamp } from '#lib/core/timestamp.tiny.ts';
import { authorNameOf, type AuthorName } from '#lib/core/history/author-name.tiny.ts';
import {
	branchName,
	isRemoteBranch,
	parseBranchRef,
	type BranchRef
} from '#lib/core/history/branch-ref.tiny.ts';
import { branchPlace } from '#lib/core/history/branch-place.ts';
import { branchCountOf, type BranchCount } from '#lib/core/history/branch-count.tiny.ts';
import { commitCountOf, type CommitCount } from '#lib/core/history/commit-count.tiny.ts';
import type { CommitParent } from '#lib/core/history/commit-selection.ts';
import type { LastFetch } from '#lib/core/history/history-words.ts';
import { parseRemoteName, type RemoteName } from '#lib/core/history/remote-name.tiny.ts';
import type { TrackedBranch } from '#lib/core/history/remote-check.ts';
import { subjectLineOf, type SubjectLine } from '#lib/core/history/subject-line.tiny.ts';
import type { GitSourceError } from './git-source-error.ts';
import { gitCwd, gitIn, type LocalRepository } from './local-repository.ts';
import { shallowBoundary } from './resolve.ts';
import { mainBranch } from './suggest-source.ts';

/** How many branches a list shows at most; the rest are found by name. */
export const BRANCHES_SHOWN = 30;

/** How many commits a page of a branch's list holds. */
export const COMMITS_PER_PAGE = 50;

/** One branch, as the chooser lists it. */
export interface BranchSummary {
	readonly ref: BranchRef;
	readonly commit: CommitId;
	/** When its newest commit was made: its committer time; undefined when git cannot read one from it. */
	readonly committedAt: Timestamp | undefined;
	/** The branch checked out in this worktree. */
	readonly current: boolean;
	/** The main branch itself: the one the others are compared with. */
	readonly main: boolean;
	/** How many commits it has that the main branch lacks; undefined with no main branch. */
	readonly ahead: CommitCount | undefined;
}

export interface Branches {
	/** The branch the others are compared with, when one can be told. */
	readonly main: BranchRef | undefined;
	/** The branches to show, the checked-out one first, then the most recently changed. */
	readonly shown: readonly BranchSummary[];
	/** How many branches match what was asked for, shown or not. */
	readonly matching: BranchCount;
	readonly remotes: readonly RemoteName[];
}

/** The repository's remotes, as `git remote` lists them. */
export async function remotesOf(
	repo: LocalRepository
): Promise<Result<readonly RemoteName[], GitSourceError>> {
	const listed = await gitIn(repo, gitCwd(repo), ['remote']);
	if (!listed.ok) return listed;
	const remotes: RemoteName[] = [];
	for (const line of listed.value.stdout.toString('utf8').split('\n')) {
		const name = parseRemoteName(line);
		if (name.ok) remotes.push(name.value);
	}
	return ok(remotes);
}

/** Text that is valid UTF-8, or undefined: a ref name that is not cannot be passed back to git as it is. */
function utf8(bytes: Buffer): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function lines(stdout: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let start = 0;
	for (let i = 0; i <= stdout.length; i += 1) {
		if (i === stdout.length || stdout[i] === 0x0a) {
			if (i > start) out.push(stdout.subarray(start, i));
			start = i + 1;
		}
	}
	return out;
}

/** The latest moment a `Date` can hold, in milliseconds: a time past it cannot be written out. */
const LATEST_TIME = 8_640_000_000_000_000;

/** A moment from git's seconds since 1970, or undefined when it holds none that can be shown. */
function timestampOfSeconds(text: string): Timestamp | undefined {
	const seconds = Number(text);
	const parsed = parseTimestamp(seconds * 1000);
	return /^[0-9]+$/.test(text) && parsed.ok && parsed.value <= LATEST_TIME
		? parsed.value
		: undefined;
}

/**
 * The repository's branches: local ones, remote-tracking ones that have no
 * local branch of the same name, and the main branch itself whichever it is,
 * since it is what every count and comparison names. With `find`, only those
 * whose name holds it, in any case. At most `BRANCHES_SHOWN` are shown;
 * `matching` counts them all.
 */
export async function listBranches(
	repo: LocalRepository,
	find: string
): Promise<Result<Branches, GitSourceError>> {
	const remotes = await remotesOf(repo);
	if (!remotes.ok) return remotes;
	const main = await mainBranch(repo);
	if (!main.ok) return main;
	const fields = [
		'%(refname)',
		'%(symref)',
		'%(HEAD)',
		'%(committerdate:unix)',
		'%(objectname)',
		...(main.value === undefined ? [] : [`%(ahead-behind:${main.value})`])
	];
	const listed = await gitIn(repo, gitCwd(repo), [
		'for-each-ref',
		`--format=${fields.join('%00')}`,
		'refs/heads/',
		'refs/remotes/'
	]);
	if (!listed.ok) return listed;
	const all: BranchSummary[] = [];
	for (const line of lines(listed.value.stdout)) {
		const text = utf8(line);
		if (text === undefined) continue;
		const [name = '', symref = '', head = '', date = '', object = '', aheadBehind = ''] =
			text.split('\0');
		if (symref !== '') continue;
		const ref = parseBranchRef(name);
		const commit = parseCommitId(object);
		if (!ref.ok || !commit.ok) continue;
		// for-each-ref writes 0, or nothing, for a commit whose time it cannot read.
		const committedAt = date === '0' ? undefined : timestampOfSeconds(date);
		const ahead = /^([0-9]+) [0-9]+$/.exec(aheadBehind)?.[1];
		all.push({
			ref: ref.value,
			commit: commit.value,
			committedAt,
			current: head === '*',
			main: false,
			ahead: ahead === undefined ? undefined : commitCountOf(Number(ahead))
		});
	}
	const locals = new Set(all.filter((b) => !isRemoteBranch(b.ref)).map((b) => branchName(b.ref)));
	const offered = all
		.filter((branch) => {
			if (!isRemoteBranch(branch.ref) || branch.ref === main.value) return true;
			const place = branchPlace(branch.ref, remotes.value);
			const there = place.kind === 'remote' ? place.nameThere : undefined;
			return there === undefined || !locals.has(there);
		})
		// Only the branch the others are compared with is the main branch: a local
		// `main` beside `origin/main` is a branch like any other, with its own count.
		.map((branch) => ({ ...branch, main: branch.ref === main.value }));
	const wanted = find.trim().toLowerCase();
	const matching = offered
		.filter((branch) => wanted === '' || branchName(branch.ref).toLowerCase().includes(wanted))
		.toSorted(
			(a, b) =>
				Number(b.current) - Number(a.current) ||
				// A branch whose time is unknown comes after those whose time is known.
				(b.committedAt ?? -1) - (a.committedAt ?? -1) ||
				(a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
		);
	return ok({
		main: main.value,
		shown: matching.slice(0, BRANCHES_SHOWN),
		matching: branchCountOf(matching.length),
		remotes: remotes.value
	});
}

/**
 * Every remote-tracking branch and the commit it is at, which is what the last
 * fetch left: what a remote's answer is compared with. One `for-each-ref`
 * over the remote branches alone, with nothing measured against the main
 * branch.
 */
export async function trackedBranches(
	repo: LocalRepository
): Promise<Result<readonly TrackedBranch[], GitSourceError>> {
	const listed = await gitIn(repo, gitCwd(repo), [
		'for-each-ref',
		'--format=%(refname)%00%(symref)%00%(objectname)',
		'refs/remotes/'
	]);
	if (!listed.ok) return listed;
	const tracked: TrackedBranch[] = [];
	for (const line of lines(listed.value.stdout)) {
		const [name = '', symref = '', object = ''] = (utf8(line) ?? '').split('\0');
		const ref = parseBranchRef(name);
		const commit = parseCommitId(object);
		if (symref === '' && ref.ok && commit.ok)
			tracked.push({ ref: ref.value, commit: commit.value });
	}
	return ok(tracked);
}

/** One commit of a branch's list. */
export interface CommitSummary {
	readonly commit: CommitId;
	readonly parent: CommitParent;
	/** A merge: more than one parent. Its size is against its first parent. */
	readonly merge: boolean;
	readonly subject: SubjectLine;
	readonly author: AuthorName;
	/** Its committer time; undefined when git cannot read one from the commit. */
	readonly committedAt: Timestamp | undefined;
	/** Its size against its first parent; undefined when it could not be measured without downloading. */
	readonly size: CommitSize | undefined;
	/** Whether the main branch has it too. */
	readonly onMain: boolean;
}

export interface CommitSize {
	readonly files: FileCount;
	readonly added: LineCount;
	readonly removed: LineCount;
}

/** Where a page of a branch's commits starts. */
export interface PageStart {
	readonly commit: CommitId;
	/**
	 * Whether the main branch has this commit. It then has every commit from here
	 * on, since they are its ancestors, so the page is listed without walking the
	 * main branch's history down to it to find out.
	 */
	readonly onMain: boolean;
}

export interface CommitPage {
	readonly commits: readonly CommitSummary[];
	/** Where the next page starts, or undefined when this is the last. */
	readonly next: PageStart | undefined;
}

/**
 * The options that make sizes the same whatever the reviewer's config: the
 * diff command's algorithm and rename detection (DESIGN 3.1), no external
 * diff, no text conversion, no colour, no signatures.
 */
const SIZE_OPTIONS = [
	'--numstat',
	'-z',
	'-M',
	'--diff-algorithm=histogram',
	'--no-ext-diff',
	'--no-textconv',
	'--no-color'
] as const;

const NUMSTAT = /^(?:\n)?([0-9]+|-)\t([0-9]+|-)\t/;

/**
 * Reads numstat entries from `tokens` starting at `at`, as `-z` writes them: one
 * token per file, `added\tremoved\tpath`, or `added\tremoved\t` and two path
 * tokens for a rename or copy. Stops at the first token that is not one.
 */
function readSizes(
	tokens: readonly string[],
	at: number
): { readonly size: CommitSize; readonly next: number } {
	let files = 0;
	let added = 0;
	let removed = 0;
	let i = at;
	for (;;) {
		const token = tokens[i];
		const match = token === undefined ? null : NUMSTAT.exec(token);
		if (token === undefined || match === null) break;
		files += 1;
		added += match[1] === '-' ? 0 : Number(match[1]);
		removed += match[2] === '-' ? 0 : Number(match[2]);
		// A rename's two paths follow in tokens of their own.
		i += token.slice(match[0].length) === '' ? 3 : 1;
	}
	return {
		size: { files: fileCountOf(files), added: lineCountOf(added), removed: lineCountOf(removed) },
		next: i
	};
}

const HEADER_FIELDS = 5;

/**
 * The commits of `log`'s output, each with its size when `sized`. Every commit
 * git lists is a row, whatever its date, author or message hold: a commit left
 * out would make the two around it look like neighbours.
 */
function readLog(
	stdout: Buffer,
	sized: boolean,
	boundary: ReadonlySet<string>
): readonly Omit<CommitSummary, 'onMain'>[] {
	const tokens = stdout.toString('utf8').split('\0');
	const commits: Omit<CommitSummary, 'onMain'>[] = [];
	let i = 0;
	while (i + HEADER_FIELDS <= tokens.length) {
		const [id = '', parents = '', date = '', author = '', subject = ''] = tokens.slice(
			i,
			i + HEADER_FIELDS
		);
		const commit = parseCommitId(id.replace(/^\n/, ''));
		if (!commit.ok) break;
		i += HEADER_FIELDS;
		let size: CommitSize | undefined;
		if (sized) {
			const read = readSizes(tokens, i);
			size = read.size;
			i = read.next;
		}
		const parentIds = parents.split(' ').filter((p) => p !== '');
		const first = parseCommitId(parentIds[0] ?? '');
		const parent: CommitParent = first.ok
			? { kind: 'commit', commit: first.value }
			: boundary.has(commit.value)
				? { kind: 'not-downloaded' }
				: { kind: 'none' };
		commits.push({
			commit: commit.value,
			parent,
			merge: parentIds.length > 1,
			subject: subjectLineOf(subject),
			author: authorNameOf(author),
			committedAt: timestampOfSeconds(date),
			// A commit whose parent was not downloaded would measure as everything it holds.
			size: parent.kind === 'not-downloaded' ? undefined : size
		});
	}
	return commits;
}

/**
 * One page of a branch's commits: its first-parent history, newest first,
 * from `from` (what a previous page gave as `next`) or the branch's newest
 * commit. Each commit has its size against its first parent, a merge too.
 */
export async function listCommits(
	repo: LocalRepository,
	branch: BranchRef,
	from: PageStart | undefined,
	main: BranchRef | undefined
): Promise<Result<CommitPage, GitSourceError>> {
	const start = from?.commit ?? branch;
	const header = '--format=%H%x00%P%x00%ct%x00%an%x00%s';
	const walk = [
		'log',
		'--first-parent',
		'--diff-merges=first-parent',
		`--max-count=${String(COMMITS_PER_PAGE + 1)}`,
		'--root',
		'--encoding=UTF-8',
		'--no-show-signature',
		'--no-mailmap',
		header
	];
	let logged = await gitIn(repo, gitCwd(repo), [
		...walk,
		...SIZE_OPTIONS,
		'--end-of-options',
		start,
		'--'
	]);
	let sized = true;
	if (!logged.ok && logged.error.kind === 'MissingObject') {
		// A partial clone without the files' contents: the commits, without their sizes.
		sized = false;
		logged = await gitIn(repo, gitCwd(repo), [...walk, '-z', '--end-of-options', start, '--']);
	}
	if (!logged.ok) {
		if (logged.error.kind === 'BadRevision') {
			const revision = parseRevision(branch);
			if (revision.ok) {
				return err({
					kind: 'UnknownRevision',
					repository: repo.commonDir,
					revision: revision.value
				});
			}
		}
		return logged;
	}
	const read = readLog(logged.value.stdout, sized, await shallowBoundary(repo));
	const page = read.slice(0, COMMITS_PER_PAGE);
	// The main branch's own commits are all on it, and so is all that follows a commit it has.
	const allOnMain = main !== undefined && (branch === main || from?.onMain === true);
	const notOnMain = allOnMain ? ok(new Set<string>()) : await notOn(repo, start, main);
	if (!notOnMain.ok) return notOnMain;
	const lacking = notOnMain.value;
	const onMain = (commit: CommitId): boolean => lacking !== undefined && !lacking.has(commit);
	const after = read[COMMITS_PER_PAGE]?.commit;
	return ok({
		commits: page.map((c) => ({ ...c, onMain: onMain(c.commit) })),
		next: after === undefined ? undefined : { commit: after, onMain: onMain(after) }
	});
}

/**
 * Which of the page's commits, and the one after it, along first parents from
 * `start`, the main branch lacks; undefined with no main branch, when every
 * commit counts as the branch's own. Lists no more than a page, but git walks
 * the main branch's history down to where the two meet to tell, which is why a
 * page that starts on the main branch never asks.
 */
async function notOn(
	repo: LocalRepository,
	start: string,
	main: BranchRef | undefined
): Promise<Result<ReadonlySet<string> | undefined, GitSourceError>> {
	if (main === undefined) return ok(undefined);
	const listed = await gitIn(repo, gitCwd(repo), [
		'rev-list',
		'--first-parent',
		`--max-count=${String(COMMITS_PER_PAGE + 1)}`,
		'--end-of-options',
		start,
		`^${main}`,
		'--'
	]);
	if (!listed.ok) return listed;
	return ok(new Set(listed.value.stdout.toString('utf8').split('\n')));
}

/**
 * The size of the diff between two commits, as a run of commits makes it: from
 * `from` (undefined for nothing before, the empty tree) to `to`. Undefined when
 * a partial clone lacks what it needs.
 */
export async function rangeSize(
	repo: LocalRepository,
	from: CommitId | undefined,
	to: CommitId
): Promise<Result<CommitSize | undefined, GitSourceError>> {
	const measured = await gitIn(repo, gitCwd(repo), [
		'diff-tree',
		'-r',
		...SIZE_OPTIONS,
		'--end-of-options',
		from ?? EMPTY_TREE[repo.objectFormat],
		to
	]);
	if (!measured.ok) return measured.error.kind === 'MissingObject' ? ok(undefined) : measured;
	return ok(readSizes(measured.value.stdout.toString('utf8').split('\0'), 0).size);
}

/** What reflog subjects say about a ref when it was updated from its remote. */
const FETCHED = /^(?:fetch|clone|pull)\b/;

/** When a ref was last updated by a fetch, clone or pull, from its reflog. */
async function lastFetchedInReflog(
	repo: LocalRepository,
	ref: string
): Promise<Timestamp | undefined> {
	const shown = await gitIn(repo, gitCwd(repo), [
		'reflog',
		'show',
		'--date=unix',
		'--format=%gd%x00%gs',
		'-n',
		'20',
		'--end-of-options',
		ref,
		'--'
	]);
	if (!shown.ok) return undefined;
	for (const line of shown.value.stdout.toString('utf8').split('\n')) {
		const [selector = '', subject = ''] = line.split('\0');
		const seconds = /@\{([0-9]+)\}$/.exec(selector)?.[1];
		if (seconds !== undefined && FETCHED.test(subject)) return timestampOfSeconds(seconds);
	}
	return undefined;
}

/**
 * When the repository last fetched, from what git records on disk: the time
 * `FETCH_HEAD` was written, which every fetch and pull rewrites, or, newer, a
 * fetch or clone in the reflog of a remote's default branch, the main branch
 * or the checked-out branch's upstream, since a clone writes no `FETCH_HEAD`.
 * Offline, and writes nothing.
 */
export async function lastFetch(
	repo: LocalRepository,
	remotes: readonly RemoteName[],
	main: BranchRef | undefined
): Promise<LastFetch> {
	if (remotes.length === 0) return { kind: 'no-remote' };
	const times: Timestamp[] = [];
	const path = await gitIn(repo, gitCwd(repo), [
		'rev-parse',
		'--path-format=absolute',
		'--git-path',
		'FETCH_HEAD'
	]);
	if (path.ok) {
		const written = await stat(path.value.stdout.toString('utf8').trim()).catch(() => undefined);
		const at = written === undefined ? undefined : parseTimestamp(Math.floor(written.mtimeMs));
		if (at?.ok === true) times.push(at.value);
	}
	const upstream = await gitIn(repo, gitCwd(repo), [
		'rev-parse',
		'--symbolic-full-name',
		'--verify',
		'--quiet',
		'@{upstream}'
	]);
	const refs = new Set([
		...remotes.map((remote) => `refs/remotes/${remote}/HEAD`),
		...(main !== undefined && isRemoteBranch(main) ? [main] : []),
		...(upstream.ok ? [upstream.value.stdout.toString('utf8').trim()] : [])
	]);
	for (const ref of refs) {
		if (!ref.startsWith('refs/remotes/')) continue;
		const at = await lastFetchedInReflog(repo, ref);
		if (at !== undefined) times.push(at);
	}
	const newest = times.toSorted((a, b) => b - a)[0];
	return newest === undefined
		? { kind: 'never', remotes }
		: { kind: 'fetched', at: newest, remotes };
}
