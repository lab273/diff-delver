/**
 * Posting a finished review to its pull request (DESIGN 8.6), through the
 * real service, with real repositories and the stand-in GitHub, which checks
 * each comment against its own diff of the pull request as GitHub does:
 * published as each kind and as a draft, what goes on lines and what in the
 * text, the fallback when GitHub refuses the lines, and that a failure
 * finishes nothing and leaves the draft, and nothing is ever posted twice.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { settableClock, type SettableClock } from '#lib/core/clock.ts';
import {
	IN_TEXT_HEADING,
	reviewMarker,
	type GitHubPosting
} from '#lib/core/github/github-review.ts';
import { parseGitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { parseReviewMark } from '#lib/core/github/review-mark.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { Result } from '#lib/core/result.ts';
import { parseReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseSourceSpec } from '#lib/core/sources/source-spec.ts';
import type { Side } from '#lib/core/side.tiny.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import {
	FIRST_REVIEW_ID,
	startGitHubStandIn,
	STAND_IN_TOKEN,
	type GitHubStandIn
} from '../../../../tests/support/github-stand-in.ts';
import {
	buildShopUpstream,
	cloneShop,
	DISCOUNT_PULL,
	serveShop,
	SHOP_NAME,
	SHOP_OWNER
} from '../../../../tests/support/pull-request-fixture.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { ApiErrorBodySchema } from '#lib/api/schemas.ts';
import { serviceFailure } from '../api/present.ts';
import { describeReportError, ReportService, type ReportError, type ShownDraft } from './index.ts';

const FIRST = value(parseRevisionNumber(1));
const DISCOUNT = value(parseSourceSpec('https://github.com/acme/shop/pull/7'));
const COMMENT: GitHubPosting = { kind: 'comment', draft: false };
const PULL = 'https://github.com/acme/shop/pull/7';

interface World {
	readonly upstream: GitRepo;
	readonly clone: GitRepo;
	readonly github: GitHubStandIn;
	readonly clock: SettableClock;
	readonly service: ReportService;
	readonly id: ReportId;
	readonly signIn: { token: string | undefined };
}

const standIns: GitHubStandIn[] = [];
afterEach(async () => {
	await Promise.all(standIns.splice(0).map((s) => s.close()));
});

/** The shop's pull request #7 opened as a Delve, by a person signed in to the stand-in. */
async function world(): Promise<World> {
	const root = await tempDirectory();
	const upstream = await GitRepo.init(absolutePath(join(root, 'upstream')));
	await buildShopUpstream(upstream);
	const clone = await cloneShop(upstream, join(root, 'shop'));
	const github = await startGitHubStandIn();
	standIns.push(github);
	await serveShop(github, upstream);
	const clock = settableClock(at(1_700_000_100_000));
	const who = await reviewer();
	const signIn: { token: string | undefined } = { token: STAND_IN_TOKEN };
	const service = value(
		await ReportService.open({
			dataDirectory: absolutePath(join(root, 'data')),
			clock,
			ids: sequentialIds(),
			repository: { gitEnv: who.gitEnv },
			github: {
				...github.access(),
				token: () =>
					Promise.resolve(
						signIn.token === undefined ? undefined : value(parseGitHubToken(signIn.token))
					)
			}
		})
	);
	const opened = value(await service.open(clone.dir, DISCOUNT));
	if (opened.kind !== 'created') throw new Error(opened.kind);
	return { upstream, clone, github, clock, service, id: opened.report.id, signIn };
}

async function comment(
	w: World,
	at: string,
	side: Side,
	first: number,
	last: number,
	body: string,
	version: RevisionNumber = FIRST
): Promise<void> {
	value(
		await w.service.addDraftComment(
			w.id,
			version,
			{
				path: value(parseRepoPath(at)),
				side,
				first: lineNumberOf(first),
				last: lineNumberOf(last)
			},
			body
		)
	);
}

function overall(w: World, body: string): void {
	const now = value(w.service.overallReview(w.id));
	value(w.service.saveOverallReview(w.id, now.edits, body));
}

/** The draft as a page shows it now. */
function shown(w: World): ShownDraft {
	return {
		comments: value(w.service.draftComments(w.id)).map((c) => ({ id: c.id, edits: c.edits })),
		overall: value(w.service.overallReview(w.id)).edits
	};
}

function post(
	w: World,
	posting: GitHubPosting = COMMENT,
	version: RevisionNumber = FIRST
): ReturnType<ReportService['postReview']> {
	return w.service.postReview(w.id, version, shown(w), posting);
}

function failure<T>(result: Result<T, ReportError>): ReportError {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

/** The secret part of the mark of the `n`th post, as the counted ids make it. */
const markOf = (n: number) => value(parseReviewMark(n.toString(16).padStart(32, '0')));

/** Moves the clock past the time GitHub may still be making a review whose post went unanswered. */
const afterAnswering = (w: World) => {
	w.clock.advance(2 * w.github.access().seconds * 1000 + 1);
};

const reviewsOnGitHub = (w: World) => w.github.reviews(SHOP_OWNER, SHOP_NAME, 7);
const posts = (w: World) => w.github.requests.filter((r) => r.method === 'POST');

/** That nothing was finished: the draft holds what it held, and no review is recorded. */
function nothingFinished(w: World, comments: number): void {
	expect(value(w.service.reviews(w.id))).toEqual([]);
	expect(value(w.service.draftComments(w.id))).toHaveLength(comments);
}

describe('posting a review to its pull request', () => {
	it('publishes one review: comments GitHub shows on their lines, the rest and the overall review in its text', async () => {
		const w = await world();
		// src/discount.ts is new, all four lines; src/price.ts gains lines 13 and 14.
		await comment(w, 'src/discount.ts', 'new', 2, 3, 'Round down, not to the nearest?');
		await comment(w, 'src/price.ts', 'new', 13, 14, 'A blank line and the export.');
		await comment(w, 'src/price.ts', 'new', 1, 1, 'Unchanged, far from the change.');
		overall(w, 'Reads well.\n\nOne question on rounding.');

		const review = value(await post(w));

		expect(review.number).toBe(1);
		expect(review.posted).toEqual({
			postedAs: 'comment',
			address: `${PULL}#pullrequestreview-${String(FIRST_REVIEW_ID)}`,
			inText: 1,
			at: at(1_700_000_100_000)
		});
		const [onGitHub, ...others] = reviewsOnGitHub(w);
		expect(others).toEqual([]);
		expect(onGitHub?.state).toBe('COMMENTED');
		expect(onGitHub?.commitId).toBe((await w.upstream.git('rev-parse', 'discount')).trim());
		expect(onGitHub?.comments).toEqual([
			{
				path: 'src/discount.ts',
				body: 'Round down, not to the nearest?',
				line: 3,
				side: 'RIGHT',
				startLine: 2,
				startSide: 'RIGHT'
			},
			{
				path: 'src/price.ts',
				body: 'A blank line and the export.',
				line: 14,
				side: 'RIGHT',
				startLine: 13,
				startSide: 'RIGHT'
			}
		]);
		expect(onGitHub?.body).toBe(
			[
				'Reads well.',
				'',
				'One question on rounding.',
				'',
				IN_TEXT_HEADING,
				'',
				'`src/price.ts`, line 1 (after the change)',
				'',
				'```typescript',
				'export function price(cents: number): number {',
				'```',
				'> Unchanged, far from the change.',
				'',
				reviewMarker(w.id, value(parseReviewNumber(1)), markOf(1))
			].join('\n')
		);
		// Finished as diff delver's review too, with the text copied, and the draft emptied.
		expect(review.text).toContain('> Round down, not to the nearest?');
		expect(value(w.service.draftComments(w.id))).toEqual([]);
		expect(value(w.service.overallReview(w.id)).body).toBe('');
		expect(value(w.service.reviews(w.id)).map((r) => r.posted?.postedAs)).toEqual(['comment']);
	});

	it('publishes as an approval or a request for changes, and as a draft on GitHub with no kind', async () => {
		const w = await world();
		overall(w, 'Approved.');
		expect(value(await post(w, { kind: 'approve', draft: false })).posted?.postedAs).toBe(
			'approve'
		);
		overall(w, 'Not yet.');
		expect(value(await post(w, { kind: 'request-changes', draft: false })).posted?.postedAs).toBe(
			'request-changes'
		);
		await comment(w, 'src/discount.ts', 'new', 1, 1, 'Say what a rate is.');
		// The kind chosen is set aside for a draft: GitHub asks for it when it is submitted.
		const draft = value(await post(w, { kind: 'approve', draft: true }));
		expect(draft.posted).toMatchObject({ postedAs: 'draft', address: `${PULL}/files` });
		expect(reviewsOnGitHub(w).map((r) => r.state)).toEqual([
			'APPROVED',
			'CHANGES_REQUESTED',
			'PENDING'
		]);
		expect(value(w.service.reviews(w.id)).map((r) => r.number)).toEqual([1, 2, 3]);
	});

	it('posts a comment on lines of an earlier version in the text, saying which version', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'Is this right?');
		await w.upstream.git('checkout', '--quiet', 'discount');
		await w.upstream.write('src/coupon.ts', 'export const COUPONS = {};\n');
		await w.upstream.commit('Add coupons');
		await w.upstream.git('checkout', '--quiet', 'main');
		await w.github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		const updated = value(await w.service.update(w.id));
		expect(updated.kind).toBe('updated');
		const second = value(parseRevisionNumber(2));
		await comment(w, 'src/coupon.ts', 'new', 1, 1, 'Empty for now?', second);

		const review = value(await post(w, COMMENT, second));

		expect(review.posted?.inText).toBe(1);
		const [onGitHub] = reviewsOnGitHub(w);
		expect(onGitHub?.comments.map((c) => c.path)).toEqual(['src/coupon.ts']);
		expect(onGitHub?.body).toContain('`src/discount.ts`, line 2 (after the change, in version 1)');
	});

	it('posts again with every comment in its text when GitHub refuses their lines, and says how many', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'One.');
		await comment(w, 'src/price.ts', 'new', 14, 14, 'Two.');
		w.github.refuseReviews({
			kind: 'status',
			status: 422,
			message: 'pull_request_review_thread.line must be part of the diff'
		});

		const review = value(await post(w));

		expect(review.posted?.inText).toBe(2);
		expect(posts(w)).toHaveLength(2);
		const [onGitHub] = reviewsOnGitHub(w);
		expect(onGitHub?.comments).toEqual([]);
		expect(onGitHub?.body).toContain('`src/discount.ts`, line 2 (after the change)');
		expect(onGitHub?.body).toContain('`src/price.ts`, line 14 (after the change)');
	});

	it('finishes nothing and keeps the draft when GitHub refuses, saying why and what to do', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'One.');

		w.signIn.token = undefined;
		const signedOut = failure(await post(w));
		expect(describeReportError(signedOut)).toMatch(
			/^Posting a review to GitHub needs you to be signed in\. Nothing was finished, and your draft is as it was\. Sign in .*"gh auth login"/
		);
		expect(posts(w)).toEqual([]);
		w.signIn.token = STAND_IN_TOKEN;

		w.github.refuseReviews({
			kind: 'status',
			status: 403,
			message: 'Resource not accessible by personal access token'
		});
		expect(describeReportError(failure(await post(w)))).toMatch(
			/^GitHub did not let your sign-in post a review to acme\/shop#7\. Nothing was finished/
		);

		w.github.refuseWith(429, { resetAt: 1_700_000_100 + 300 });
		expect(describeReportError(failure(await post(w)))).toMatch(
			/too many requests .* Finish again in 5 minutes\.$/
		);
		w.github.refuseWith(undefined);
		// diff delver waits as GitHub asked, asking nothing meanwhile.
		w.clock.set(at(1_700_000_100_000 + 301_000));

		w.github.refuseReviews({ kind: 'status', status: 422, message: 'Validation Failed' });
		expect(describeReportError(failure(await post(w)))).toMatch(
			/^GitHub refused the review\. Nothing was finished/
		);

		nothingFinished(w, 1);
		expect(reviewsOnGitHub(w)).toEqual([]);
		// And once GitHub takes it, it is finished.
		expect(value(await post(w)).number).toBe(1);
	});

	it('says GitHub refused the review even with every comment in its text only when it was posted so', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'On its line.');
		const lines = {
			kind: 'status',
			status: 422,
			message: 'pull_request_review_thread.line must be part of the diff'
		} as const;
		w.github.refuseReviews(lines, lines);
		expect(describeReportError(failure(await post(w)))).toMatch(
			/^GitHub refused the review, even with every comment in its text\. Nothing was finished/
		);
		expect(posts(w)).toHaveLength(2);

		// With no comment on its lines, it is not posted again, and says nothing of the text.
		const v = await world();
		overall(v, 'Only an overall review.');
		v.github.refuseReviews(lines);
		const said = describeReportError(failure(await post(v)));
		expect(said).toMatch(/^GitHub refused the review\. Nothing was finished/);
		expect(said).not.toContain('every comment');
		expect(posts(v)).toHaveLength(1);
	});

	it('says plainly when the review is too long for GitHub, and posts nothing', async () => {
		const w = await world();
		// Unchanged lines far from the change go in the review's text, with their code.
		for (let i = 0; i < 7; i += 1) {
			await comment(w, 'src/price.ts', 'new', 1, 1, `${String(i)}${'x'.repeat(9_999)}`);
		}
		const said = describeReportError(failure(await post(w)));
		expect(said).toMatch(
			/^The review is too long for GitHub, which takes at most 65,536 characters in a review's text and in each comment; this one has 70,\d{3}\. Nothing was finished, and your draft is as it was\. Shorten the overall review or the comments that go in the review's text, or finish and copy only/
		);
		expect(posts(w)).toEqual([]);
		nothingFinished(w, 7);
		// GitHub's own refusal for length says the same.
		const v = await world();
		overall(v, 'Short.');
		v.github.refuseReviews({
			kind: 'status',
			status: 422,
			message: 'Body is too long (maximum is 65536 characters)'
		});
		expect(describeReportError(failure(await post(v)))).toMatch(
			/^The review is too long for GitHub, which takes at most 65,536 characters in a review's text and in each comment\. Nothing/
		);
	});

	it('says the pull request has moved on when the commit reviewed is no longer part of it', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'On the old commit.');
		// A force-push while the Delve still shows version 1.
		await w.upstream.git('checkout', '--quiet', 'discount');
		await w.upstream.write('src/discount.ts', 'export const RATE = 0.1;\n');
		await w.upstream.git('commit', '--quiet', '--all', '--amend', '--no-edit');
		await w.upstream.git('checkout', '--quiet', 'main');
		await w.github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);

		expect(describeReportError(failure(await post(w)))).toBe(
			"acme/shop#7 has moved on: the commit of the version you are reviewing is no longer part of it on GitHub, as after a force-push. Nothing was finished, and your draft is as it was. Update this Delve to the pull request's newest version, then finish again, or finish and copy only."
		);
		expect(posts(w)).toHaveLength(1);
		nothingFinished(w, 1);
	});

	it('says when the reviewer has a draft on GitHub already, or would approve their own pull request', async () => {
		const w = await world();
		overall(w, 'First draft.');
		value(await post(w, { kind: 'comment', draft: true }));
		overall(w, 'Second draft.');
		expect(describeReportError(failure(await post(w, { kind: 'comment', draft: true })))).toMatch(
			/^You already have a draft review of acme\/shop#7 on GitHub, and while it is a draft GitHub takes no other review from you\. .* Submit or delete that draft on GitHub, then finish again\.$/
		);
		// Nor a published one.
		expect(describeReportError(failure(await post(w, COMMENT)))).toMatch(
			/^You already have a draft review of acme\/shop#7 on GitHub/
		);
		expect(value(w.service.overallReview(w.id)).body).toBe('Second draft.');
		expect(value(w.service.reviews(w.id))).toHaveLength(1);

		const own = await world();
		overall(own, 'My own.');
		await own.github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, author: 'reviewer' });
		expect(
			describeReportError(failure(await post(own, { kind: 'approve', draft: false })))
		).toMatch(/^GitHub does not let you approve your own pull request\. .* Choose Comment/);
	});

	it('does not post to a pull request that was merged or closed', async () => {
		const w = await world();
		overall(w, 'Late.');
		await w.github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, state: 'merged' });
		expect(describeReportError(failure(await post(w)))).toMatch(
			/^acme\/shop#7 was merged on GitHub, so diff delver will not post a review to it\./
		);
		expect(posts(w)).toEqual([]);
		expect(value(w.service.overallReview(w.id)).body).toBe('Late.');
	});

	it('never posts twice: a review GitHub made, whose answer never came, is found by its mark and recorded', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'One.');
		w.github.refuseReviews({ kind: 'drop-answer' });

		const lost = failure(await post(w));
		expect(lost).toMatchObject({ kind: 'ReviewNotPosted', problem: { kind: 'unreachable' } });
		nothingFinished(w, 1);
		expect(reviewsOnGitHub(w)).toHaveLength(1);

		const review = value(await post(w));
		// Looked for, and found: not posted again.
		expect(posts(w)).toHaveLength(1);
		expect(w.github.requests.at(-1)).toMatchObject({ method: 'GET' });
		expect(reviewsOnGitHub(w)).toHaveLength(1);
		expect(review.posted?.address).toBe(`${PULL}#pullrequestreview-${String(FIRST_REVIEW_ID)}`);
		expect(value(w.service.draftComments(w.id))).toEqual([]);
	});

	it('records an unanswered post as it was sent, and keeps what was added or changed since in the draft', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'Sent and kept.');
		await comment(w, 'src/price.ts', 'new', 14, 14, 'Sent, then changed.');
		overall(w, 'The overall review sent.');
		w.github.refuseReviews({ kind: 'drop-answer' });
		expect(failure(await post(w, { kind: 'approve', draft: false }))).toMatchObject({
			problem: { kind: 'unreachable' }
		});

		// Meanwhile the reviewer adds a comment, changes one and the overall review, and picks another kind.
		await comment(w, 'src/discount.ts', 'new', 3, 3, 'Added since.');
		const [, changed] = value(w.service.draftComments(w.id));
		if (changed === undefined) throw new Error('no comment');
		value(w.service.editDraftComment(w.id, FIRST, changed.id, changed.edits, 'Changed since.'));
		overall(w, 'The overall review changed since.');
		const review = value(await post(w, COMMENT));

		expect(posts(w)).toHaveLength(1);
		// Recorded as GitHub has it: approved, with what was sent then.
		expect(review.earlier).toEqual({ draftKept: true });
		expect(review.posted).toMatchObject({ postedAs: 'approve', inText: 0 });
		expect(review.comments).toBe(2);
		expect(review.text).toContain('> Sent and kept.');
		expect(review.text).toContain('> Sent, then changed.');
		expect(review.text).toContain('The overall review sent.');
		expect(review.text).not.toContain('since');
		expect(value(w.service.review(w.id))?.text).toBe(review.text);
		// What was added or changed since stays in the draft, for the next review; the
		// comment changed since is a new one, since its earlier words are finished.
		const left = value(w.service.draftComments(w.id));
		expect(left.map((c) => c.body)).toEqual(['Added since.', 'Changed since.']);
		expect(left.map((c) => c.id)).not.toContain(changed.id);
		expect(value(w.service.overallReview(w.id)).body).toBe('The overall review changed since.');
		const next = value(await post(w));
		expect(next.number).toBe(2);
		expect(next.earlier).toBeUndefined();
		expect(reviewsOnGitHub(w).map((r) => r.state)).toEqual(['APPROVED', 'COMMENTED']);
	});

	it('records an unanswered fallback post with every comment in its text, as it was sent', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'One.');
		w.github.refuseReviews(
			{
				kind: 'status',
				status: 422,
				message: 'pull_request_review_thread.line must be part of the diff'
			},
			{ kind: 'drop-answer' }
		);
		failure(await post(w, { kind: 'comment', draft: true }));
		const review = value(await post(w));
		expect(review.posted).toMatchObject({ postedAs: 'draft', inText: 1, address: `${PULL}/files` });
		expect(review.earlier).toEqual({ draftKept: false });
		expect(value(w.service.draftComments(w.id))).toEqual([]);
	});

	it('never takes a review planted to look like the one an unanswered post left for its own', async () => {
		const w = await world();
		overall(w, 'Mine.');
		const one = value(parseReviewNumber(1));
		w.github.refuseReviews({ kind: 'status', status: 502, message: 'Bad Gateway' });
		failure(await post(w));
		// Another account copies the mark of the post that never reached GitHub, and one
		// without its secret is planted as the reviewer's own.
		w.github.plantReview(SHOP_OWNER, SHOP_NAME, 7, {
			user: 'someone-else',
			state: 'APPROVED',
			body: `Planted.\n\n${reviewMarker(w.id, one, markOf(1))}`
		});
		w.github.plantReview(SHOP_OWNER, SHOP_NAME, 7, {
			user: 'reviewer',
			state: 'COMMENTED',
			body: `Guessed.\n\n<!-- diff delver: review 1 of ${w.id} -->`
		});
		afterAnswering(w);

		const review = value(await post(w));

		expect(review.earlier).toBeUndefined();
		expect(posts(w)).toHaveLength(2);
		const mine = reviewsOnGitHub(w).at(-1);
		// Posted again with the mark it was first posted with.
		expect(mine?.body).toBe(`Mine.\n\n${reviewMarker(w.id, one, markOf(1))}`);
		expect(review.posted?.address).toBe(`${PULL}#pullrequestreview-${String(mine?.id)}`);
		expect(w.github.requests.some((r) => r.path === '/user')).toBe(true);
	});

	it('posts once when an unanswered post never reached GitHub, after looking for it there', async () => {
		const w = await world();
		overall(w, 'Once.');
		w.github.refuseReviews({ kind: 'status', status: 502, message: 'Bad Gateway' });
		expect(failure(await post(w))).toMatchObject({ problem: { kind: 'unreadable' } });
		afterAnswering(w);

		value(await post(w));
		const asked = w.github.requests.filter((r) => r.path.includes('/reviews'));
		expect(asked.map((r) => r.method)).toEqual(['POST', 'GET', 'POST']);
		expect(reviewsOnGitHub(w)).toHaveLength(1);
	});

	it('waits for GitHub to make a review whose post timed out, rather than post it again', async () => {
		const w = await world();
		overall(w, 'Made late.');
		const one = value(parseReviewNumber(1));
		w.github.refuseReviews({ kind: 'make-late' });
		failure(await post(w));
		// GitHub makes it, but only later: the review is not there to be found yet.
		expect(reviewsOnGitHub(w)).toEqual([]);

		// Pressed again at once, either button: refused, saying to wait, and nothing posted or forgotten.
		const soon = failure(await post(w));
		expect(soon).toMatchObject({ problem: { kind: 'earlier-post-recent', number: one } });
		expect(describeReportError(soon)).toBe(
			'Your post of review 1 to GitHub went unanswered a moment ago, and GitHub may still be making it, so diff delver will not post it again yet. Nothing was finished, and your draft is as it was. Finish again in a minute. diff delver then looks on GitHub for that review first, records it as posted if it is there, and never posts it twice.'
		);
		expect(failure(await w.service.finishReview(w.id, FIRST, shown(w)))).toMatchObject({
			problem: { kind: 'earlier-post-recent' }
		});
		expect(posts(w)).toHaveLength(1);
		nothingFinished(w, 0);

		// Still not there once the wait is over: posted again, with the same mark.
		afterAnswering(w);
		value(await post(w));
		expect(posts(w)).toHaveLength(2);
		// Had GitHub made the first after all, both carry the one mark, so either is found by it.
		w.github.makeLateReviews();
		expect(reviewsOnGitHub(w).map((r) => r.body)).toEqual([
			`Made late.\n\n${reviewMarker(w.id, one, markOf(1))}`,
			`Made late.\n\n${reviewMarker(w.id, one, markOf(1))}`
		]);
	});

	it('records a review GitHub made late, found once the wait is over, without posting it again', async () => {
		const w = await world();
		overall(w, 'Made late.');
		w.github.refuseReviews({ kind: 'make-late' });
		failure(await post(w));
		failure(await post(w));

		// GitHub has it now.
		w.github.makeLateReviews();
		afterAnswering(w);
		const review = value(await post(w));
		expect(review.earlier).toEqual({ draftKept: false });
		expect(posts(w)).toHaveLength(1);
		expect(reviewsOnGitHub(w)).toHaveLength(1);
	});

	it('records a review GitHub took while the Delve was updated or closed, as it was sent', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'Before the update.');
		const arrived = Promise.withResolvers<undefined>();
		const answer = Promise.withResolvers<undefined>();
		w.github.refuseReviews({
			kind: 'wait',
			arrived: () => {
				arrived.resolve(undefined);
			},
			until: answer.promise
		});
		const posting = post(w);
		await arrived.promise;

		// While GitHub makes it, someone pushes and the Delve is updated, then closed.
		await w.upstream.git('checkout', '--quiet', 'discount');
		await w.upstream.write('src/coupon.ts', 'export const COUPONS = {};\n');
		await w.upstream.commit('Add coupons');
		await w.upstream.git('checkout', '--quiet', 'main');
		await w.github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		expect(value(await w.service.update(w.id)).kind).toBe('updated');
		value(w.service.closeReport(w.id));
		answer.resolve(undefined);

		const review = value(await posting);
		expect(review.version).toBe(1);
		expect(review.posted?.address).toBe(`${PULL}#pullrequestreview-${String(FIRST_REVIEW_ID)}`);
		expect(review.text).toContain('> Before the update.');
		expect(value(w.service.reviews(w.id)).map((r) => r.number)).toEqual([1]);
		expect(value(w.service.draftComments(w.id))).toEqual([]);
	});

	it('posts or finishes a Delve’s draft once at a time', async () => {
		const w = await world();
		overall(w, 'Only once.');
		const draft = shown(w);
		const [one, two, three] = await Promise.all([
			w.service.postReview(w.id, FIRST, draft, COMMENT),
			w.service.postReview(w.id, FIRST, draft, COMMENT),
			w.service.finishReview(w.id, FIRST, draft)
		]);
		expect(one.ok).toBe(true);
		expect(failure(two)).toMatchObject({ problem: { kind: 'being-posted' } });
		expect(failure(three)).toMatchObject({ problem: { kind: 'being-posted' } });
		expect(reviewsOnGitHub(w)).toHaveLength(1);
		expect(value(w.service.reviews(w.id))).toHaveLength(1);
	});

	it('never posts a draft being finished and copied only, nor finishes one being posted', async () => {
		const w = await world();
		overall(w, 'Finished first.');
		const draft = shown(w);
		const [copied, posted] = await Promise.all([
			w.service.finishReview(w.id, FIRST, draft),
			w.service.postReview(w.id, FIRST, draft, COMMENT)
		]);
		expect(value(copied).posted).toBeUndefined();
		expect(failure(posted)).toMatchObject({ problem: { kind: 'being-posted' } });
		expect(describeReportError(failure(posted))).toMatch(
			/^This review is being finished or posted to GitHub already/
		);
		expect(posts(w)).toEqual([]);
		expect(value(w.service.reviews(w.id))).toHaveLength(1);

		overall(w, 'Posted first.');
		const again = shown(w);
		const [postedNow, copiedNow] = await Promise.all([
			w.service.postReview(w.id, FIRST, again, COMMENT),
			w.service.finishReview(w.id, FIRST, again)
		]);
		expect(value(postedNow).posted?.postedAs).toBe('comment');
		expect(failure(copiedNow)).toMatchObject({ problem: { kind: 'being-posted' } });
		expect(reviewsOnGitHub(w)).toHaveLength(1);
		expect(value(w.service.reviews(w.id)).map((r) => r.number)).toEqual([1, 2]);
	});

	it('shows what posting would put on GitHub before it is posted: the text, and which comments go where', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'On its line.');
		await comment(w, 'src/price.ts', 'new', 1, 1, 'Far from the change.');
		overall(w, 'Overall.');
		const [online, far] = value(w.service.draftComments(w.id));
		const asked = w.github.requests.length;

		const preview = value(await w.service.previewReview(w.id, FIRST));

		expect(preview.github?.onLines).toEqual(new Set([online?.id]));
		expect(far).toBeDefined();
		expect(preview.github?.body).toBe(
			[
				'Overall.',
				'',
				IN_TEXT_HEADING,
				'',
				'`src/price.ts`, line 1 (after the change)',
				'',
				'```typescript',
				'export function price(cents: number): number {',
				'```',
				'> Far from the change.'
			].join('\n')
		);
		// GitHub is not asked.
		expect(w.github.requests).toHaveLength(asked);
	});

	it('still finishes and copies a pull request’s review without posting it', async () => {
		const w = await world();
		overall(w, 'Just for my agent.');
		const review = value(await w.service.finishReview(w.id, FIRST, shown(w)));
		expect(review.posted).toBeUndefined();
		expect(w.github.requests.filter((r) => r.path.includes('/reviews'))).toEqual([]);
	});

	it('looks on GitHub before finishing and copying only, after a post whose answer never came', async () => {
		const w = await world();
		await comment(w, 'src/discount.ts', 'new', 2, 2, 'One.');
		w.github.refuseReviews({ kind: 'drop-answer' });
		failure(await post(w));

		// GitHub cannot be asked: nothing is finished, since review 1 may be on GitHub.
		w.signIn.token = undefined;
		const unchecked = failure(await w.service.finishReview(w.id, FIRST, shown(w)));
		expect(describeReportError(unchecked)).toBe(
			'Your earlier post of review 1 to GitHub may have reached it, and diff delver could not ask GitHub whether it did: you are not signed in to GitHub ("gh auth login" signs you in). Nothing was finished, and your draft is as it was. Once GitHub can be asked, finish again: diff delver looks for that review first, records it as posted if it is there, and never posts it twice. If GitHub may never be asked, as when the repository is gone or your access to it was taken away, choose “Finish and copy anyway”: review 1 is then finished and copied without posting, though it may be on GitHub already.'
		);
		nothingFinished(w, 1);
		w.signIn.token = STAND_IN_TOKEN;

		// Asked, it is there: recorded as posted, not as copied only.
		const review = value(await w.service.finishReview(w.id, FIRST, shown(w)));
		expect(review.earlier).toEqual({ draftKept: false });
		expect(review.posted).toMatchObject({
			postedAs: 'comment',
			address: `${PULL}#pullrequestreview-${String(FIRST_REVIEW_ID)}`
		});
		expect(posts(w)).toHaveLength(1);
		expect(value(w.service.draftComments(w.id))).toEqual([]);
	});

	it('finishes and copies anyway, when asked, after an unanswered post GitHub cannot be asked about', async () => {
		const w = await world();
		overall(w, 'Stuck.');
		w.github.refuseReviews({ kind: 'drop-answer' });
		failure(await post(w));
		// The reviewer can no longer sign in, so the earlier post cannot be looked for.
		w.signIn.token = undefined;
		const unchecked = failure(await w.service.finishReview(w.id, FIRST, shown(w)));
		expect(unchecked).toMatchObject({ problem: { kind: 'earlier-post-unchecked' } });
		// The page is told which refusal it is, to offer the choice.
		const answer = ApiErrorBodySchema.parse(await serviceFailure(unchecked).json());
		expect(answer.error.kind).toBe('EarlierPostUnchecked');

		const asked = w.github.requests.length;
		const review = value(
			await w.service.finishReview(w.id, FIRST, shown(w), { forgetEarlierPost: true })
		);
		// Finished as copied only, without asking GitHub, and the earlier post forgotten.
		expect(review.number).toBe(1);
		expect(review.posted).toBeUndefined();
		expect(review.earlier).toBeUndefined();
		expect(review.text).toContain('Stuck.');
		expect(w.github.requests).toHaveLength(asked);
		expect(value(w.service.overallReview(w.id)).body).toBe('');

		w.signIn.token = STAND_IN_TOKEN;
		overall(w, 'Next.');
		expect(value(await post(w)).number).toBe(2);
		// Review 1 is not looked for again.
		const reviewsAsked = w.github.requests.filter((r) => r.path.includes('/reviews'));
		expect(reviewsAsked.map((r) => r.method)).toEqual(['POST', 'POST']);
	});

	it('finishes and copies only once GitHub says an earlier unanswered post is not there', async () => {
		const w = await world();
		overall(w, 'Never reached GitHub.');
		w.github.refuseReviews({ kind: 'status', status: 502, message: 'Bad Gateway' });
		failure(await post(w));
		afterAnswering(w);

		const review = value(await w.service.finishReview(w.id, FIRST, shown(w)));
		expect(review.posted).toBeUndefined();
		expect(review.earlier).toBeUndefined();
		expect(reviewsOnGitHub(w)).toEqual([]);
		// The note is forgotten: the next post does not look for review 1 again.
		overall(w, 'Second.');
		value(await post(w));
		const asked = w.github.requests.filter((r) => r.path.includes('/reviews'));
		expect(asked.map((r) => r.method)).toEqual(['POST', 'GET', 'POST']);
	});

	it('refuses to post a Delve that is not of a pull request', async () => {
		const w = await world();
		await w.clone.write('src/price.ts', 'changed\n');
		const local = value(await w.service.open(w.clone.dir, value(parseSourceSpec('working-tree'))));
		if (local.kind !== 'created') throw new Error(local.kind);
		const id = local.report.id;
		value(w.service.saveOverallReview(id, value(w.service.overallReview(id)).edits, 'Hm.'));
		const refused = failure(
			await w.service.postReview(
				id,
				FIRST,
				{ comments: [], overall: value(w.service.overallReview(id)).edits },
				COMMENT
			)
		);
		expect(refused.kind).toBe('NotAPullRequest');
	});
});
