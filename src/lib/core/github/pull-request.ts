/**
 * A GitHub pull request as a source (DESIGN 3.1, 6.1): which one it is, read
 * from its address, the words for it (DESIGN 8.5), and what a Delve of it says
 * when it has nothing left to review because it was merged or closed.
 *
 * Its identity is its host, owner, repository and number (DESIGN 6.1), owner
 * and repository in lowercase, as GitHub compares them, so opening it again,
 * from its address or from a list, resumes the same Delve.
 */
import { visibleText } from '../hidden-characters.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { NothingLeft } from '../reports/nothing-left.ts';
import { gitHubRepositoryOf, type GitHubRepository } from './github-repository.ts';
import { parsePullRequestNumber, type PullRequestNumber } from './pull-request-number.tiny.ts';
import type { PullRequestTitle } from './pull-request-title.tiny.ts';

/** One pull request: its repository and its number. */
export interface PullRequestRef {
	readonly repository: GitHubRepository;
	readonly number: PullRequestNumber;
}

/** Where a pull request is now, as GitHub says. */
export type PullRequestState = 'open' | 'closed' | 'merged';

/** What was given is not the address of a pull request diff delver can open. */
export interface InvalidPullRequestUrl {
	readonly kind: 'InvalidPullRequestUrl';
	readonly text: string;
	/** `not-github`: the address is of another site; `not-a-pull-request`: of GitHub, but not of a pull request. */
	readonly reason: 'not-github' | 'not-a-pull-request';
}

/** Whether text is written as a web address, so it is read as a pull request's or not at all. */
export function looksLikeAddress(text: string): boolean {
	return /^https?:\/\//i.test(text.trim());
}

/**
 * Reads a pull request's address as a browser shows it:
 * `https://github.com/owner/name/pull/123`, with anything after the number,
 * such as `/files`, a query or a `#` part, ignored.
 */
export function parsePullRequestUrl(text: string): Result<PullRequestRef, InvalidPullRequestUrl> {
	const typed = text.trim();
	let url: URL;
	try {
		url = new URL(typed);
	} catch {
		return err({ kind: 'InvalidPullRequestUrl', text, reason: 'not-a-pull-request' });
	}
	const match = /^\/([^/]+)\/([^/]+)\/pulls?\/(\d+)(?:\/.*)?$/.exec(url.pathname);
	const site = url.protocol === 'https:' || url.protocol === 'http:';
	const repository =
		match === null || !site
			? undefined
			: gitHubRepositoryOf(`https://${url.hostname}/${match[1] ?? ''}/${match[2] ?? ''}`);
	if (repository === undefined) {
		const onGitHub = gitHubRepositoryOf(`https://${url.hostname}/a/b`) !== undefined;
		return err({
			kind: 'InvalidPullRequestUrl',
			text,
			reason: onGitHub ? 'not-a-pull-request' : 'not-github'
		});
	}
	const number = parsePullRequestNumber(Number(match?.[3]));
	if (!number.ok) return err({ kind: 'InvalidPullRequestUrl', text, reason: 'not-a-pull-request' });
	return ok({ repository, number: number.value });
}

/** The pull request's address: `https://github.com/owner/name/pull/123`, which `parsePullRequestUrl` reads back. */
export function pullRequestUrl(ref: PullRequestRef): string {
	const { host, owner, name } = ref.repository;
	return `https://${host}/${owner}/${name}/pull/${String(ref.number)}`;
}

/** The parts of the pull request's identity (DESIGN 6.1), after the kind. */
export function pullRequestIdentityParts(ref: PullRequestRef): readonly string[] {
	const { host, owner, name } = ref.repository;
	return [host, owner.toLowerCase(), name.toLowerCase(), String(ref.number)];
}

/** Whether two name the same pull request. */
export function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
	return pullRequestIdentityParts(a).join('/') === pullRequestIdentityParts(b).join('/');
}

/** How long a title may be in a Delve's title before it is cut short. */
const TITLE_IN_SENTENCE = 80;

/** A title as a sentence quotes it: what cannot be seen written out, and cut short if long. */
export function quotedTitle(title: PullRequestTitle): string {
	if (title.trim() === '') return '“(no title)”';
	const shown = visibleText(title);
	let kept = '';
	let count = 0;
	for (const character of shown) {
		count += 1;
		if (count < TITLE_IN_SENTENCE) kept += character;
	}
	return `“${count > TITLE_IN_SENTENCE ? `${kept}…` : shown}”`;
}

/**
 * A Delve of a pull request, as its title: `Pull request #123: “Add a discount
 * rate”`, or `Pull request #123` before its title is known.
 */
export function describePullRequest(
	ref: PullRequestRef,
	title: PullRequestTitle | undefined
): ReviewerMessage {
	const named = `Pull request #${String(ref.number)}`;
	return reviewerMessage(title === undefined ? named : `${named}: ${quotedTitle(title)}`);
}

/** The pull request as GitHub writes it in text: `owner/name#123`. */
export function pullRequestShortName(ref: PullRequestRef): string {
	return `${ref.repository.owner}/${ref.repository.name}#${String(ref.number)}`;
}

/** What is wrong with an address given as a pull request's, and what to give instead. */
export function describeInvalidPullRequestUrl(error: InvalidPullRequestUrl): ReviewerMessage {
	const example = 'such as https://github.com/owner/repository/pull/123';
	switch (error.reason) {
		case 'not-github':
			return reviewerMessage(
				`diff delver can open pull requests on github.com only, and "${visibleText(error.text.trim())}" is not on github.com. Give the address of a pull request on github.com, ${example}.`
			);
		case 'not-a-pull-request':
			return reviewerMessage(
				`"${visibleText(error.text.trim())}" is not the address of a pull request. Give one as your browser shows it, ${example}.`
			);
	}
}

/**
 * What a Delve of a pull request says when it has nothing left to review
 * (DESIGN 6.1): merged, closed, or with no changes against its base any more.
 * There is nothing to offer instead: a merged pull request's changes are on its
 * base branch now, which the choose page opens.
 */
export function pullRequestNothingLeft(ref: PullRequestRef, state: PullRequestState): NothingLeft {
	const named = `pull request #${String(ref.number)}`;
	const shown = 'What you were reading is still shown.';
	switch (state) {
		case 'merged':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: ${named} has been merged. ${shown}`
				),
				next: undefined
			};
		case 'closed':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: ${named} has been closed without being merged. ${shown}`
				),
				next: undefined
			};
		case 'open':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: ${named} has no changes compared with its base branch any more. ${shown}`
				),
				next: undefined
			};
	}
}

/**
 * How a pull request changed on GitHub since the version a Delve shows: new
 * commits on its branch (pushed, or force-pushed), or only its base, which it
 * was retargeted to or which took in some of its commits.
 */
export type PullRequestChange = 'pushed' | 'base';

/** What a page says of a pull request that changed, before offering to update. */
export function describePullRequestChange(change: PullRequestChange): ReviewerMessage {
	switch (change) {
		case 'pushed':
			return reviewerMessage(
				'New commits were pushed to it on GitHub. What you see here is how it was before.'
			);
		case 'base':
			return reviewerMessage(
				'Its base changed on GitHub: it merges into another branch now, or its base branch took in some of its commits. What you see here is how it was before.'
			);
	}
}

/** Why a pull request had nothing to review when it was opened, and what to do instead. */
export function describePullRequestNothingToReview(state: PullRequestState): ReviewerMessage {
	switch (state) {
		case 'merged':
			return reviewerMessage(
				'This pull request has been merged, so there is nothing left to review. Its changes are on its base branch now: choose its commits there to read them.'
			);
		case 'closed':
			return reviewerMessage(
				'This pull request has been closed without being merged, so there is nothing to review. Reopen it on GitHub to review it here.'
			);
		case 'open':
			return reviewerMessage(
				'This pull request changes no files compared with its base branch, so there is nothing to review.'
			);
	}
}
