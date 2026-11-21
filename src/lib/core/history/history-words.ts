/**
 * The words of the page that chooses commits or a branch to review (DESIGN
 * 8.5): when something happened, exactly, and how long ago; how far a branch
 * has gone from the main branch; and when the repository last fetched.
 *
 * Written out by hand, in UTC, so they read the same on every machine and do
 * not depend on its language or timezone.
 */
import { describeTimeAgo } from '../time-ago.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { visibleText } from '../hidden-characters.ts';
import { formatCount } from '../viewer/words.ts';
import { isMisleadingBranchName } from '../sources/git-source-spec.ts';
import { branchPlace } from './branch-place.ts';
import { branchName, type BranchRef } from './branch-ref.tiny.ts';
import type { CommitCount } from './commit-count.tiny.ts';
import type { RemoteName } from './remote-name.tiny.ts';

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
] as const;

/** A moment exactly, in UTC: "15 January 2026, 09:30 UTC". */
export function describeExactTime(at: Timestamp): ReviewerMessage {
	const date = new Date(at);
	const two = (n: number): string => String(n).padStart(2, '0');
	const month = MONTHS[date.getUTCMonth()] ?? '';
	return reviewerMessage(
		`${String(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`
	);
}

/** When something happened, in words and exactly: "3 days ago (12 January 2026, 10:00 UTC)". */
export function describeWhen(at: Timestamp, now: Timestamp): ReviewerMessage {
	return reviewerMessage(`${describeTimeAgo(at, now)} (${describeExactTime(at)})`);
}

/** When a branch's newest commit was made, as its row says it: "last commit 3 days ago". */
export function describeLastCommit(at: Timestamp | undefined, now: Timestamp): ReviewerMessage {
	return reviewerMessage(
		at === undefined ? 'last commit at an unknown time' : `last commit ${describeTimeAgo(at, now)}`
	);
}

/** What a commit's row says in place of its time when git cannot read one from the commit. */
export const UNKNOWN_COMMIT_TIME = reviewerMessage('Time unknown');

/**
 * Whether a local branch's name could be read as something else: as a remote's
 * branch, because it starts with a remote's name and a slash, or as the
 * checked-out commit or a source's word (`HEAD`, `staged`).
 */
function isMisleading(branch: BranchRef, remotes: readonly RemoteName[]): boolean {
	const place = branchPlace(branch, remotes);
	return (
		place.kind === 'local' && (place.looksRemote || isMisleadingBranchName(branchName(branch)))
	);
}

/**
 * A branch as a sentence names it, with what cannot be seen written out:
 * "feature-x", "origin/feature-x", and "the local branch origin/main" or "the
 * local branch HEAD" for a local branch whose name alone would be read as
 * something else. `remotes` are the repository's.
 */
export function shownBranch(branch: BranchRef, remotes: readonly RemoteName[]): ReviewerMessage {
	const name = visibleText(branchName(branch));
	return reviewerMessage(isMisleading(branch, remotes) ? `the local branch ${name}` : name);
}

/** `shownBranch` to start a sentence with: a name as it is written, a phrase with a capital. */
function branchFirst(branch: BranchRef, remotes: readonly RemoteName[]): string {
	const name = visibleText(branchName(branch));
	return isMisleading(branch, remotes) ? `The local branch ${name}` : name;
}

/**
 * The tag beside a branch's name in a list or a heading, which tells apart two
 * branches whose names read the same: "On origin" for this copy's record of a
 * remote's branch, "Local branch" for a local branch whose name could be read
 * as something else; none for any other local branch.
 */
export function describeBranchPlace(
	branch: BranchRef,
	remotes: readonly RemoteName[]
): ReviewerMessage | undefined {
	const place = branchPlace(branch, remotes);
	switch (place.kind) {
		case 'local':
			return isMisleading(branch, remotes) ? reviewerMessage('Local branch') : undefined;
		case 'remote':
			return reviewerMessage(
				place.remote === undefined ? 'Remote branch' : `On ${visibleText(place.remote)}`
			);
	}
}

/** How many commits a branch has that the main branch lacks: "3 commits not on main". */
export function describeAhead(
	ahead: CommitCount,
	main: BranchRef,
	remotes: readonly RemoteName[]
): ReviewerMessage {
	const name = shownBranch(main, remotes);
	if (ahead === 0) return reviewerMessage(`No commits that ${name} lacks`);
	return reviewerMessage(
		ahead === 1 ? `1 commit not on ${name}` : `${formatCount(ahead)} commits not on ${name}`
	);
}

/** What the page says above the commits of a branch that has none the main branch lacks. */
export function describeNothingAhead(
	branch: BranchRef,
	main: BranchRef,
	remotes: readonly RemoteName[]
): ReviewerMessage {
	const on = shownBranch(main, remotes);
	return reviewerMessage(
		`${branchFirst(branch, remotes)} has no commits that ${on} lacks: every commit below is on ${on} too. Tick commits to review them.`
	);
}

/** Where a branch's own commits end in its list, said above the first commit the main branch has too. */
export function describeForkPoint(
	branch: BranchRef,
	main: BranchRef,
	remotes: readonly RemoteName[]
): ReviewerMessage {
	const on = shownBranch(main, remotes);
	return reviewerMessage(
		`${branchFirst(branch, remotes)} started from ${on} here: the commits below are on ${on} too.`
	);
}

/** What the button that reviews a whole branch says. */
export function describeWholeBranch(
	main: BranchRef,
	ahead: CommitCount,
	remotes: readonly RemoteName[]
): ReviewerMessage {
	const commits = ahead === 1 ? '1 commit' : `${formatCount(ahead)} commits`;
	return reviewerMessage(
		`Review the whole branch: ${commits}, compared with ${shownBranch(main, remotes)}`
	);
}

/** When the repository last fetched, as git records it on disk. */
export type LastFetch =
	/** The repository has no remote, so there is nothing to fetch from. */
	| { readonly kind: 'no-remote' }
	/** It has remotes and no record of a fetch. */
	| { readonly kind: 'never'; readonly remotes: readonly RemoteName[] }
	| { readonly kind: 'fetched'; readonly at: Timestamp; readonly remotes: readonly RemoteName[] };

function remotesText(remotes: readonly RemoteName[]): string {
	const [only, ...others] = remotes;
	return only !== undefined && others.length === 0
		? visibleText(only)
		: `its ${formatCount(remotes.length)} remotes`;
}

/**
 * When the repository last fetched, in a sentence, or undefined when it has no
 * remote: "Last fetched from origin 3 days ago (12 January 2026, 10:00 UTC)."
 */
export function describeLastFetch(fetch: LastFetch, now: Timestamp): ReviewerMessage | undefined {
	switch (fetch.kind) {
		case 'no-remote':
			return undefined;
		case 'never':
			return reviewerMessage(
				`This copy has no record of fetching from ${remotesText(fetch.remotes)}, so it may lack commits made there.`
			);
		case 'fetched':
			return reviewerMessage(
				`Last fetched from ${remotesText(fetch.remotes)} ${describeWhen(fetch.at, now)}.`
			);
	}
}

/** What the button that asks the remotes what they have says. */
export function describeCheckButton(remotes: readonly RemoteName[]): ReviewerMessage {
	const [only, ...others] = remotes;
	return reviewerMessage(
		only !== undefined && others.length === 0
			? `Check ${visibleText(only)} for new commits`
			: 'Check the remotes for new commits'
	);
}
