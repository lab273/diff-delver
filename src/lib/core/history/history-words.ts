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

/** A branch as the page names it, with what cannot be seen written out: "feature-x", "origin/feature-x". */
export function shownBranch(branch: BranchRef): ReviewerMessage {
	return reviewerMessage(visibleText(branchName(branch)));
}

/** How many commits a branch has that the main branch lacks: "3 commits not on main". */
export function describeAhead(ahead: CommitCount, main: BranchRef): ReviewerMessage {
	const name = shownBranch(main);
	if (ahead === 0) return reviewerMessage(`No commits that ${name} lacks`);
	return reviewerMessage(
		ahead === 1 ? `1 commit not on ${name}` : `${formatCount(ahead)} commits not on ${name}`
	);
}

/** Where a branch's own commits end in its list, said above the first commit the main branch has too. */
export function describeForkPoint(branch: BranchRef, main: BranchRef): ReviewerMessage {
	return reviewerMessage(
		`${shownBranch(branch)} started from ${shownBranch(main)} here: the commits below are on ${shownBranch(main)} too.`
	);
}

/** What the button that reviews a whole branch says. */
export function describeWholeBranch(main: BranchRef, ahead: CommitCount): ReviewerMessage {
	const commits = ahead === 1 ? '1 commit' : `${formatCount(ahead)} commits`;
	return reviewerMessage(`Review the whole branch: ${commits}, compared with ${shownBranch(main)}`);
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
