/**
 * Posting a finished review to its pull request as one GitHub review
 * (DESIGN 8.6), and finding one posted before: the two calls of GitHub's
 * reviews API diff delver makes, each only when the reviewer finishes a
 * review to post. The token goes only into the request's header.
 *
 * What can go wrong is said as a `ReviewPostProblem`, each with its message,
 * which always says that nothing was finished and the draft is as it was.
 */
import { z } from 'zod';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import {
	gitHubEvent,
	type GitHubLineComment,
	type GitHubReviewKind
} from '#lib/core/github/github-review.ts';
import {
	parseGitHubReviewId,
	type GitHubReviewId
} from '#lib/core/github/github-review-id.tiny.ts';
import type { GitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { pullRequestShortName, type PullRequestRef } from '#lib/core/github/pull-request.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import type { GitHubAccess } from './github-access.ts';
import { ask, refusal, repositoryPath, type Answer } from './github-api.ts';
import type { GitHubApiError, GitHubRateLimited } from './github-error.ts';

/** A review on GitHub: its id, and whether it is pending, a draft only its author sees. */
export interface GitHubReviewFound {
	readonly id: GitHubReviewId;
	readonly pending: boolean;
}

/** The review as it is posted: on which commit, published as which kind or left a draft. */
export interface ReviewToPost {
	readonly commit: CommitId;
	/** The kind to publish it as; undefined leaves it a draft on GitHub. */
	readonly kind: GitHubReviewKind | undefined;
	readonly body: string;
	readonly comments: readonly GitHubLineComment[];
}

/** Why a review was not posted. */
export type ReviewPostProblem =
	| { readonly kind: 'signed-out' }
	| { readonly kind: 'sign-in-refused' }
	| { readonly kind: 'not-allowed' }
	| { readonly kind: 'rate-limited'; readonly limit: GitHubRateLimited }
	| { readonly kind: 'unreachable' }
	/** GitHub did not answer in time, so the review may have been posted. */
	| { readonly kind: 'unanswered'; readonly seconds: number }
	| { readonly kind: 'unreadable'; readonly status: number }
	/** The reviewer has a draft review on GitHub already, and GitHub allows one. */
	| { readonly kind: 'pending-review-exists' }
	/** GitHub does not let anyone approve, or ask for changes on, their own pull request. */
	| { readonly kind: 'own-pull-request'; readonly review: GitHubReviewKind }
	/** GitHub refused the review, even with every comment in its text. */
	| { readonly kind: 'refused' }
	/** GitHub refused to place the comments on their lines; posting again with them in the text may work. */
	| { readonly kind: 'lines-refused' }
	| { readonly kind: 'closed'; readonly merged: boolean }
	/** Another press is posting this Delve's draft now. */
	| { readonly kind: 'being-posted' }
	/** The version reviewed has no commit to post on, which a pull request's always has. */
	| { readonly kind: 'no-commit' };

/** A review could not be posted to its pull request. Nothing was finished. */
export interface ReviewNotPosted {
	readonly kind: 'ReviewNotPosted';
	readonly pullRequest: PullRequestRef | undefined;
	readonly problem: ReviewPostProblem;
}

/** A Delve that is not of a pull request has nowhere on GitHub to post to. */
export interface NotAPullRequest {
	readonly kind: 'NotAPullRequest';
}

/** A refusal of GitHub's API as a reason the review was not posted. */
export function problemOf(error: GitHubApiError): ReviewPostProblem {
	switch (error.kind) {
		case 'GitHubUnreachable':
			return { kind: 'unreachable' };
		case 'GitHubTimedOut':
			return { kind: 'unanswered', seconds: error.seconds };
		case 'GitHubSignInNeeded':
			return { kind: 'signed-out' };
		case 'GitHubSignInRefused':
			return { kind: 'sign-in-refused' };
		case 'GitHubNoAccess':
		case 'PullRequestNotFound':
			return { kind: 'not-allowed' };
		case 'GitHubRateLimited':
			return { kind: 'rate-limited', limit: error };
		case 'GitHubAnswerUnreadable':
			return { kind: 'unreadable', status: error.status };
	}
}

function reviewsPath(ref: PullRequestRef): string {
	return `${repositoryPath(ref.repository)}/pulls/${String(ref.number)}/reviews`;
}

const reviewShape = z.object({
	id: z.number().transform((value, context) => {
		const parsed = parseGitHubReviewId(value);
		if (parsed.ok) return parsed.value;
		context.addIssue({ code: 'custom', message: 'not an id' });
		return z.NEVER;
	}),
	body: z.string().nullable().optional(),
	state: z.string()
});

/** What GitHub's 422 says is wrong, from its message and errors, which are GitHub's own words. */
function unprocessable(answer: Answer, kind: GitHubReviewKind | undefined): ReviewPostProblem {
	const said = JSON.stringify(answer.body ?? '').toLowerCase();
	if (said.includes('pending review')) return { kind: 'pending-review-exists' };
	if (said.includes('own pull request') && kind !== undefined) {
		return { kind: 'own-pull-request', review: kind };
	}
	return { kind: 'lines-refused' };
}

/**
 * Posts the review, as one GitHub review: published as its kind, or, with
 * none, left pending, a draft only the reviewer sees until they submit it.
 * GitHub's 422 for lines it cannot place is `lines-refused`, so the caller
 * can post again with every comment in the text.
 */
export async function postReview(
	access: GitHubAccess,
	ref: PullRequestRef,
	review: ReviewToPost,
	now: Timestamp
): Promise<Result<GitHubReviewFound, ReviewPostProblem>> {
	const token = await access.token(ref.repository.host);
	if (token === undefined) return err({ kind: 'signed-out' });
	const sent = {
		commit_id: review.commit,
		body: review.body,
		...(review.kind === undefined ? {} : { event: gitHubEvent(review.kind) }),
		comments: review.comments.map((c) => ({
			path: c.path,
			body: c.body,
			line: c.line,
			side: c.side,
			...(c.startLine === undefined ? {} : { start_line: c.startLine, start_side: c.side })
		}))
	};
	const asked = await ask(access, ref.repository, reviewsPath(ref), token, undefined, sent);
	if (!asked.ok) return err(problemOf(asked.error));
	if (asked.value.status === 422) return err(unprocessable(asked.value, review.kind));
	if (asked.value.status !== 200 && asked.value.status !== 201) {
		return err(problemOf(refusal(asked.value, ref.repository, token, now)));
	}
	const read = reviewShape.safeParse(asked.value.body);
	if (!read.success) return err({ kind: 'unreadable', status: asked.value.status });
	return ok({ id: read.data.id, pending: read.data.state === 'PENDING' });
}

/** At most this many pages of a pull request's reviews are looked through for one posted before. */
const REVIEW_PAGES_SEARCHED = 10;

/**
 * The review on the pull request whose text holds `marker`, as a review
 * posted before whose answer never came would; undefined when there is none.
 * GitHub lists the signed-in person's own draft among them.
 */
export async function findReview(
	access: GitHubAccess,
	ref: PullRequestRef,
	marker: string,
	now: Timestamp
): Promise<Result<GitHubReviewFound | undefined, ReviewPostProblem>> {
	const token: GitHubToken | undefined = await access.token(ref.repository.host);
	if (token === undefined) return err({ kind: 'signed-out' });
	for (let page = 1; page <= REVIEW_PAGES_SEARCHED; page += 1) {
		const query = new URLSearchParams({ per_page: '100', page: String(page) });
		const asked = await ask(
			access,
			ref.repository,
			`${reviewsPath(ref)}?${query.toString()}`,
			token
		);
		if (!asked.ok) return err(problemOf(asked.error));
		if (asked.value.status !== 200) {
			return err(problemOf(refusal(asked.value, ref.repository, token, now)));
		}
		const read = z.array(reviewShape).safeParse(asked.value.body);
		if (!read.success) return err({ kind: 'unreadable', status: asked.value.status });
		const found = read.data.find((r) => (r.body ?? '').includes(marker));
		if (found !== undefined) return ok({ id: found.id, pending: found.state === 'PENDING' });
		if (!/rel="next"/.test(asked.value.headers.get('link') ?? '')) return ok(undefined);
	}
	return ok(undefined);
}

const NOTHING_FINISHED = 'Nothing was finished, and your draft is as it was.';

/** When to try again, from how long GitHub asked to wait. */
function describeWait(seconds: number | undefined): string {
	if (seconds === undefined) return 'Wait a few minutes, then finish again.';
	if (seconds <= 60) return 'Finish again in a minute.';
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 120) return `Finish again in ${String(minutes)} minutes.`;
	return `Finish again in ${String(Math.ceil(minutes / 60))} hours.`;
}

/** What happened and what to do next, for the reviewer. */
export function describeReviewNotPosted(error: ReviewNotPosted): ReviewerMessage {
	const pull =
		error.pullRequest === undefined ? 'the pull request' : pullRequestShortName(error.pullRequest);
	const { problem } = error;
	const said = ((): string => {
		switch (problem.kind) {
			case 'signed-out':
				return `Posting a review to GitHub needs you to be signed in. ${NOTHING_FINISHED} Sign in with the GitHub command, "gh auth login", or set GITHUB_TOKEN to a token that can write pull requests, then finish again. To hand the review over without posting it, finish and copy only.`;
			case 'sign-in-refused':
				return `GitHub refused the sign-in diff delver found: it has most likely expired. ${NOTHING_FINISHED} Sign in again with "gh auth login", or set GITHUB_TOKEN to a new token, then finish again.`;
			case 'not-allowed':
				return `GitHub did not let your sign-in post a review to ${pull}. ${NOTHING_FINISHED} Check that the account you signed in with ("gh auth status" shows it) can see the repository, and that its token may write pull requests, then finish again.`;
			case 'rate-limited':
				return `GitHub has had too many requests from your account for now, so the review was not posted. ${NOTHING_FINISHED} ${describeWait(problem.limit.waitSeconds)}`;
			case 'unreachable':
				return `GitHub could not be reached, so the review was not posted. ${NOTHING_FINISHED} Check that this computer is online, then finish again.`;
			case 'unanswered':
				return `GitHub did not answer within ${String(problem.seconds)} seconds, so diff delver cannot tell whether your review was posted. ${NOTHING_FINISHED} Finish again: diff delver first looks on GitHub for this review, so it is never posted twice.`;
			case 'unreadable':
				return `GitHub answered in a way diff delver could not read (status ${String(problem.status)}), so diff delver cannot tell whether your review was posted. ${NOTHING_FINISHED} Finish again: diff delver first looks on GitHub for this review, so it is never posted twice.`;
			case 'pending-review-exists':
				return `You already have a draft review of ${pull} on GitHub, and GitHub keeps one at a time. ${NOTHING_FINISHED} Submit or delete that draft on GitHub, then finish again.`;
			case 'own-pull-request':
				return `GitHub does not let you ${problem.review === 'approve' ? 'approve' : 'request changes on'} your own pull request. ${NOTHING_FINISHED} Choose Comment, then finish again.`;
			case 'refused':
			case 'lines-refused':
				return `GitHub refused the review, even with every comment in its text. ${NOTHING_FINISHED} Finish and copy only to hand it over, or try again later.`;
			case 'closed':
				return `${pull} was ${problem.merged ? 'merged' : 'closed'} on GitHub, so diff delver will not post a review to it. ${NOTHING_FINISHED} Finish and copy only to hand the review over.`;
			case 'being-posted':
				return `This review is being posted to GitHub already, perhaps from another tab. ${NOTHING_FINISHED} Wait for it, then look under Finished reviews.`;
			case 'no-commit':
				return `This version of the Delve has no commit to post the review on. ${NOTHING_FINISHED} Finish and copy only to hand the review over.`;
		}
	})();
	return reviewerMessage(said);
}

/** What happened and what to do next, for a Delve that is not of a pull request. */
export function describeNotAPullRequest(): ReviewerMessage {
	return reviewerMessage(
		'This Delve is not of a GitHub pull request, so there is nowhere on GitHub to post its review. Finish and copy it instead.'
	);
}
