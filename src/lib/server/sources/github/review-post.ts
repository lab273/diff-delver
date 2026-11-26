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
	GITHUB_TEXT_LIMIT,
	type GitHubLineComment,
	type GitHubReviewKind,
	type PostedAs
} from '#lib/core/github/github-review.ts';
import {
	parseGitHubReviewId,
	type GitHubReviewId
} from '#lib/core/github/github-review-id.tiny.ts';
import type { GitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { pullRequestShortName, type PullRequestRef } from '#lib/core/github/pull-request.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { formatCount } from '#lib/core/viewer/words.ts';
import type { GitHubAccess } from './github-access.ts';
import { ask, refusal, repositoryPath, type Answer } from './github-api.ts';
import type { GitHubApiError, GitHubRateLimited } from './github-error.ts';

/**
 * A review on GitHub: its id, and what it is there, from its state: a draft
 * (pending, which only its author sees) or published as one of the kinds;
 * undefined for a state that is none of them, such as a dismissed review.
 */
export interface GitHubReviewFound {
	readonly id: GitHubReviewId;
	readonly postedAs: PostedAs | undefined;
}

/** What a review's state on GitHub says it was posted as. */
function postedAsOf(state: string): PostedAs | undefined {
	switch (state) {
		case 'PENDING':
			return 'draft';
		case 'COMMENTED':
			return 'comment';
		case 'APPROVED':
			return 'approve';
		case 'CHANGES_REQUESTED':
			return 'request-changes';
		default:
			return undefined;
	}
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
	/**
	 * GitHub refused the review for a reason it gave in its own words; with
	 * `allInText`, when it was posted again with every comment in its text.
	 */
	| { readonly kind: 'refused'; readonly allInText: boolean }
	/** The review's text, or a comment, is longer than GitHub takes: `length` characters. */
	| { readonly kind: 'too-long'; readonly length: number }
	/** The commit reviewed is no longer part of the pull request, as after a force-push. */
	| { readonly kind: 'moved-on' }
	/** GitHub refused to place the comments on their lines; posting again with them in the text may work. */
	| { readonly kind: 'lines-refused' }
	| { readonly kind: 'closed'; readonly merged: boolean }
	/** Another press is finishing or posting this Delve's draft now. */
	| { readonly kind: 'being-posted' }
	/** The version reviewed has no commit to post on, which a pull request's always has. */
	| { readonly kind: 'no-commit' }
	/**
	 * An earlier post of review `number` may have reached GitHub unanswered,
	 * and GitHub could not be asked whether it did, so it is not finished
	 * without posting, which could leave it on GitHub unrecorded.
	 */
	/**
	 * An earlier post of review `number` went unanswered so recently that
	 * GitHub may still be making it, where it cannot be found yet: nothing is
	 * posted or finished for another `waitSeconds`.
	 */
	| {
			readonly kind: 'earlier-post-recent';
			readonly number: ReviewNumber;
			readonly waitSeconds: number;
	  }
	| {
			readonly kind: 'earlier-post-unchecked';
			readonly number: ReviewNumber;
			readonly cause: ReviewPostProblem;
	  };

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
	state: z.string(),
	/** Its author; null for an account since deleted. */
	user: z.object({ id: z.number() }).nullable().optional()
});

/** The signed-in account, as `GET /user` gives it. */
const userShape = z.object({ id: z.number().int().positive() });

/**
 * What GitHub's 422 says is wrong, from its message and errors, which are
 * GitHub's own words: only an error that names a line, a path, a position or
 * the diff is about the comments' lines.
 */
function unprocessable(answer: Answer, kind: GitHubReviewKind | undefined): ReviewPostProblem {
	const said = JSON.stringify(answer.body ?? '').toLowerCase();
	if (said.includes('pending review')) return { kind: 'pending-review-exists' };
	if (said.includes('own pull request') && kind !== undefined) {
		return { kind: 'own-pull-request', review: kind };
	}
	if (said.includes('too long')) return { kind: 'too-long', length: GITHUB_TEXT_LIMIT + 1 };
	if (/\bcommit/.test(said)) return { kind: 'moved-on' };
	if (/\b(line|lines|start_line|path|position|diff|resolved)\b/.test(said)) {
		return { kind: 'lines-refused' };
	}
	return { kind: 'refused', allInText: false };
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
	return ok({ id: read.data.id, postedAs: postedAsOf(read.data.state) });
}

/** At most this many pages of a pull request's reviews are looked through for one posted before. */
const REVIEW_PAGES_SEARCHED = 10;

/**
 * The review on the pull request whose text holds `marker` and whose author
 * is the account signed in, as a review posted before whose answer never
 * came would be; undefined when there is none. Anyone can post a review
 * whose text looks like diff delver's, so one by another account is never
 * taken for it. GitHub lists the signed-in person's own draft among them.
 */
export async function findReview(
	access: GitHubAccess,
	ref: PullRequestRef,
	marker: string,
	now: Timestamp
): Promise<Result<GitHubReviewFound | undefined, ReviewPostProblem>> {
	const token: GitHubToken | undefined = await access.token(ref.repository.host);
	if (token === undefined) return err({ kind: 'signed-out' });
	const who = await ask(access, ref.repository, '/user', token);
	if (!who.ok) return err(problemOf(who.error));
	if (who.value.status !== 200) {
		return err(problemOf(refusal(who.value, ref.repository, token, now)));
	}
	const me = userShape.safeParse(who.value.body);
	if (!me.success) return err({ kind: 'unreadable', status: who.value.status });
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
		const found = read.data.find(
			(r) => r.user?.id === me.data.id && (r.body ?? '').includes(marker)
		);
		if (found !== undefined) return ok({ id: found.id, postedAs: postedAsOf(found.state) });
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

/** Why GitHub could not be asked, as words that follow "could not ask GitHub whether it did:". */
function whyUnasked(cause: ReviewPostProblem): string {
	switch (cause.kind) {
		case 'signed-out':
			return 'you are not signed in to GitHub ("gh auth login" signs you in)';
		case 'sign-in-refused':
			return 'GitHub refused your sign-in, which has most likely expired ("gh auth login" signs you in again)';
		case 'not-allowed':
			return 'GitHub did not let your sign-in see the pull request’s reviews';
		case 'rate-limited':
			return 'GitHub has had too many requests from your account for now';
		case 'unreachable':
			return 'GitHub could not be reached';
		case 'unanswered':
			return `GitHub did not answer within ${String(cause.seconds)} seconds`;
		case 'unreadable':
		case 'pending-review-exists':
		case 'own-pull-request':
		case 'refused':
		case 'lines-refused':
		case 'too-long':
		case 'moved-on':
		case 'closed':
		case 'being-posted':
		case 'no-commit':
		case 'earlier-post-recent':
		case 'earlier-post-unchecked':
			return 'GitHub did not answer in a way diff delver could read';
	}
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
				return `GitHub did not answer within ${String(problem.seconds)} seconds, so diff delver cannot tell whether your review was posted. ${NOTHING_FINISHED} Wait a minute, then finish again: diff delver first looks on GitHub for this review, so it is never posted twice.`;
			case 'unreadable':
				return `GitHub answered in a way diff delver could not read (status ${String(problem.status)}), so diff delver cannot tell whether your review was posted. ${NOTHING_FINISHED} Wait a minute, then finish again: diff delver first looks on GitHub for this review, so it is never posted twice.`;
			case 'pending-review-exists':
				return `You already have a draft review of ${pull} on GitHub, and while it is a draft GitHub takes no other review from you. ${NOTHING_FINISHED} Submit or delete that draft on GitHub, then finish again.`;
			case 'own-pull-request':
				return `GitHub does not let you ${problem.review === 'approve' ? 'approve' : 'request changes on'} your own pull request. ${NOTHING_FINISHED} Choose Comment, then finish again.`;
			case 'refused':
				return problem.allInText
					? `GitHub refused the review, even with every comment in its text. ${NOTHING_FINISHED} Finish and copy only to hand it over, or try again later.`
					: `GitHub refused the review. ${NOTHING_FINISHED} Finish and copy only to hand it over, or try again later.`;
			case 'lines-refused':
				return `GitHub refused to place the review's comments on their lines. ${NOTHING_FINISHED} Finish and copy only to hand it over, or try again later.`;
			case 'too-long':
				return `The review is too long for GitHub, which takes at most ${formatCount(GITHUB_TEXT_LIMIT)} characters in a review's text and in each comment${problem.length > GITHUB_TEXT_LIMIT + 1 ? `; this one has ${formatCount(problem.length)}` : ''}. ${NOTHING_FINISHED} Shorten the overall review or the comments that go in the review's text, or finish and copy only to hand it over without posting it.`;
			case 'moved-on':
				return `${pull} has moved on: the commit of the version you are reviewing is no longer part of it on GitHub, as after a force-push. ${NOTHING_FINISHED} Update this Delve to the pull request's newest version, then finish again, or finish and copy only.`;
			case 'closed':
				return `${pull} was ${problem.merged ? 'merged' : 'closed'} on GitHub, so diff delver will not post a review to it. ${NOTHING_FINISHED} Finish and copy only to hand the review over.`;
			case 'being-posted':
				return `This review is being finished or posted to GitHub already, perhaps from another tab. ${NOTHING_FINISHED} Wait for it, then look under Finished reviews.`;
			case 'no-commit':
				return `This version of the Delve has no commit to post the review on. ${NOTHING_FINISHED} Finish and copy only to hand the review over.`;
			case 'earlier-post-recent':
				return `Your post of review ${String(problem.number)} to GitHub went unanswered a moment ago, and GitHub may still be making it, so diff delver will not post it again yet. ${NOTHING_FINISHED} ${describeWait(problem.waitSeconds)} diff delver then looks on GitHub for that review first, records it as posted if it is there, and never posts it twice.`;
			case 'earlier-post-unchecked':
				return `Your earlier post of review ${String(problem.number)} to GitHub may have reached it, and diff delver could not ask GitHub whether it did: ${whyUnasked(problem.cause)}. ${NOTHING_FINISHED} Once GitHub can be asked, finish again: diff delver looks for that review first, records it as posted if it is there, and never posts it twice. If GitHub may never be asked, as when the repository is gone or your access to it was taken away, choose “Finish and copy anyway”: review ${String(problem.number)} is then finished and copied without posting, though it may be on GitHub already.`;
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
