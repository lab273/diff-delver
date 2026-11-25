/**
 * An open pull request as the choose page lists it (DESIGN 3.1, 8.2): what
 * GitHub says of it, and the words its row shows.
 */
import { visibleText } from '../hidden-characters.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { describeTimeAgo } from '../time-ago.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { formatCount } from '../viewer/words.ts';
import type { GitHubBranchName } from './github-branch-name.tiny.ts';
import type { GitHubOwner } from './github-owner.tiny.ts';
import type { PullRequestNumber } from './pull-request-number.tiny.ts';
import type { PullRequestTitle } from './pull-request-title.tiny.ts';

export interface ListedPullRequest {
	readonly number: PullRequestNumber;
	readonly title: PullRequestTitle;
	/** Who opened it; undefined for an account that has been deleted. */
	readonly author: GitHubOwner | undefined;
	/** The branch it would merge, by its name in the repository it is in. */
	readonly head: GitHubBranchName;
	/** The branch it would merge into. */
	readonly base: GitHubBranchName;
	/** Whether its branch is in another repository, a fork. */
	readonly fromFork: boolean;
	readonly draft: boolean;
	readonly updatedAt: Timestamp;
}

/**
 * The first line of its row: `#12 Add a discount rate`. The title is as GitHub
 * gave it: a page shows it with what cannot be seen marked (`VisibleText`).
 */
export function describeListedTitle(pull: ListedPullRequest): ReviewerMessage {
	return reviewerMessage(`#${String(pull.number)} ${pull.title}`);
}

/**
 * The second line of its row: `By octo, from feature-x into main, updated 3
 * hours ago`, a fork's branch as `a fork's feature-x`.
 */
export function describeListedDetails(pull: ListedPullRequest, now: Timestamp): ReviewerMessage {
	const by = pull.author === undefined ? 'By a deleted account' : `By ${pull.author}`;
	const head = `${pull.fromFork ? 'a fork’s ' : ''}${visibleText(pull.head)}`;
	return reviewerMessage(
		`${by}, from ${head} into ${visibleText(pull.base)}, updated ${describeTimeAgo(pull.updatedAt, now)}`
	);
}

/**
 * What the list says of itself, given how many it lists, whether GitHub has
 * more, and the repository as GitHub names it: "3 open pull requests in
 * acme/shop, most recently updated first. Choose one to review it."
 */
export function describePullRequestList(
	count: number,
	more: boolean,
	repository: string
): ReviewerMessage {
	if (count === 0) return reviewerMessage(`${repository} has no open pull requests.`);
	if (count === 1 && !more) {
		return reviewerMessage(`1 open pull request in ${repository}. Choose it to review it.`);
	}
	const counted = `${formatCount(count)} open pull requests`;
	return reviewerMessage(
		more
			? `The ${counted} in ${repository} updated most recently. Choose one to review it.`
			: `${counted} in ${repository}, most recently updated first. Choose one to review it.`
	);
}
