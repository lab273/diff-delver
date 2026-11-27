/**
 * A Delve's history (DESIGN 6.4), pure: its versions and finished reviews in
 * the order they happened, each version with when it arrived and what changed,
 * each review with how it was handed over and where its threads stand today;
 * and, for one review, what it held, each item against the version it was
 * written on.
 */
import { describePostedAs } from '../github/github-review.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { ReviewNumber } from '../review-number.tiny.ts';
import type { FinishedReview, Handover } from '../review/review-export.ts';
import type { CommentAnchor, ThreadKind } from '../review/draft-comment.ts';
import type { ThreadId } from '../thread-id.tiny.ts';
import type { ThreadMessage, ThreadResolution, ThreadStatus } from '../review/threads.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { describeTimeAgo } from '../time-ago.ts';
import { describeReviewContents } from '../review/overall-review.ts';
import { countOf } from '../viewer/words.ts';
import type { UpdateSummary } from '../update/update-summary.ts';
import { describeUpdate } from '../update/update-summary.ts';

/** A version as the timeline lists it. */
export interface TimelineVersion {
	readonly number: RevisionNumber;
	readonly arrivedAt: Timestamp;
	/** What the update that made it did; undefined for the first. */
	readonly update: UpdateSummary | undefined;
}

/** A thread as the timeline needs it: who started it, its messages and resolutions, its status today. */
export interface ThreadToday {
	readonly id: ThreadId;
	readonly kind: ThreadKind;
	readonly messages: readonly ThreadMessage[];
	readonly resolutions: readonly ThreadResolution[];
	readonly status: ThreadStatus;
}

export type TimelineEntry =
	| { readonly kind: 'version'; readonly version: TimelineVersion }
	| { readonly kind: 'review'; readonly review: FinishedReview };

/**
 * The versions and reviews in the order they happened: each version, then
 * the reviews finished on it, by number. A review is finished on the version
 * that was current then, so this is the order of time too.
 */
export function timelineOf(
	versions: readonly TimelineVersion[],
	reviews: readonly FinishedReview[]
): readonly TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	const byVersion = [...versions].sort((a, b) => a.number - b.number);
	const sorted = [...reviews].sort((a, b) => a.version - b.version || a.number - b.number);
	let next = 0;
	for (const version of byVersion) {
		// A review on a version the list lacks still comes in its place.
		while ((sorted[next]?.version ?? Infinity) < version.number) {
			const review = sorted[next];
			if (review !== undefined) entries.push({ kind: 'review', review });
			next += 1;
		}
		entries.push({ kind: 'version', version });
		while (sorted[next]?.version === version.number) {
			const review = sorted[next];
			if (review !== undefined) entries.push({ kind: 'review', review });
			next += 1;
		}
	}
	for (const review of sorted.slice(next)) entries.push({ kind: 'review', review });
	return entries;
}

/** What a version brought: "The first version." or what its update did. */
export function describeArrival(version: TimelineVersion): ReviewerMessage {
	return version.update === undefined
		? reviewerMessage('The first version.')
		: describeUpdate(version.update);
}

function describeHandover(what: string, handover: Handover, now: Timestamp): string {
	return handover.times === 1
		? `${what} ${describeTimeAgo(handover.first, now)}`
		: `${what} ${countOf(handover.times, 'time', 'times')}, last ${describeTimeAgo(handover.last, now)}`;
}

/**
 * How a review was handed over, one sentence for each way: "Posted to GitHub
 * as a comment 2 days ago", "Copied 3 times, last 1 hour ago", "Read by an
 * agent 5 minutes ago". None when nothing was kept, as for a review finished
 * before its copies were noted.
 */
export function describeDeliveries(
	review: FinishedReview,
	now: Timestamp
): readonly ReviewerMessage[] {
	return [
		...(review.posted === undefined
			? []
			: [
					`Posted to GitHub ${describePostedAs(review.posted.postedAs)} ${describeTimeAgo(review.posted.at, now)}`
				]),
		...(review.copied === undefined ? [] : [describeHandover('Copied', review.copied, now)]),
		...(review.read === undefined ? [] : [describeHandover('Read by an agent', review.read, now)])
	].map(reviewerMessage);
}

/** How many of some threads stand each way today. */
export interface StatusCounts {
	readonly open: number;
	readonly changed: number;
	readonly resolved: number;
}

/** The threads a review started, by its comments and flags, counted by their status today. */
export function startedBy(threads: readonly ThreadToday[], review: ReviewNumber): StatusCounts {
	let open = 0;
	let changed = 0;
	let resolved = 0;
	for (const t of threads) {
		if (t.messages[0]?.review !== review) continue;
		if (t.status === 'open') open += 1;
		else if (t.status === 'changed') changed += 1;
		else resolved += 1;
	}
	return { open, changed, resolved };
}

/**
 * Where a review's comments stand today, in words: "Today: 2 open, 1 code
 * changed since, 1 resolved"; undefined when it started none.
 */
export function describeToday(counts: StatusCounts): ReviewerMessage | undefined {
	const parts = [
		...(counts.open > 0 ? [`${String(counts.open)} open`] : []),
		...(counts.changed > 0 ? [`${String(counts.changed)} code changed since`] : []),
		...(counts.resolved > 0 ? [`${String(counts.resolved)} resolved`] : [])
	];
	return parts.length === 0 ? undefined : reviewerMessage(`Today: ${parts.join(', ')}`);
}

/** One thing a finished review held, against the version it was written on. */
export interface ReviewItem {
	readonly thread: ThreadId;
	/** A comment or flag that started a thread, or a reply to an earlier review's. */
	readonly kind: 'comment' | 'flag' | 'reply';
	/** For a reply, the review whose comment it answers. */
	readonly answers: ReviewNumber | undefined;
	readonly version: RevisionNumber;
	readonly anchor: CommentAnchor;
	readonly body: string;
	/** Where its thread stands today. */
	readonly status: ThreadStatus;
}

/** A thread a finished review resolved or opened again. */
export interface ReviewResolution {
	readonly thread: ThreadId;
	readonly resolved: boolean;
	/** The review whose comment started it. */
	readonly from: ReviewNumber | undefined;
	readonly anchor: CommentAnchor | undefined;
	readonly status: ThreadStatus;
}

/** What review `number` held, in the order its threads were started, and what it resolved. */
export function reviewItems(
	threads: readonly ThreadToday[],
	number: ReviewNumber
): { readonly items: readonly ReviewItem[]; readonly resolutions: readonly ReviewResolution[] } {
	const items: ReviewItem[] = [];
	const resolutions: ReviewResolution[] = [];
	for (const t of threads) {
		const start = t.messages[0];
		for (const [i, m] of t.messages.entries()) {
			if (m.review !== number) continue;
			items.push({
				thread: t.id,
				kind: i === 0 ? m.kind : 'reply',
				answers: i === 0 ? undefined : start?.review,
				version: m.version,
				anchor: m.anchor,
				body: m.body,
				status: t.status
			});
		}
		for (const r of t.resolutions) {
			if (r.review !== number) continue;
			resolutions.push({
				thread: t.id,
				resolved: r.resolved,
				from: start?.review,
				anchor: start?.anchor,
				status: t.status
			});
		}
	}
	return { items, resolutions };
}

/**
 * What a finished review held, in words, with the comments of earlier
 * reviews it resolved or opened again: "1 comment", "an overall review and
 * 1 earlier comment resolved or reopened".
 */
export function describeHeld(
	review: FinishedReview,
	threads: readonly ThreadToday[]
): ReviewerMessage {
	const done = threads.flatMap((t) => t.resolutions.filter((r) => r.review === review.number));
	const resolved = done.filter((r) => r.resolved).length;
	const reopened = done.length - resolved;
	const own =
		review.comments > 0 || review.flags > 0 || review.overall || done.length === 0
			? [describeReviewContents(review, 'listed')]
			: [];
	const earlier = [
		...(resolved > 0
			? [countOf(resolved, 'earlier comment resolved', 'earlier comments resolved')]
			: []),
		...(reopened > 0
			? [countOf(reopened, 'earlier comment reopened', 'earlier comments reopened')]
			: [])
	];
	const all = [...own, ...earlier];
	const last = all.pop() ?? '';
	return reviewerMessage(all.length === 0 ? last : `${all.join(', ')} and ${last}`);
}

/** What an item is, in words: "Comment", "Flag", "Reply to review 1". */
export function describeItemKind(item: Pick<ReviewItem, 'kind' | 'answers'>): ReviewerMessage {
	switch (item.kind) {
		case 'comment':
			return reviewerMessage('Comment');
		case 'flag':
			return reviewerMessage('Flag');
		case 'reply':
			return reviewerMessage(
				item.answers === undefined ? 'Reply' : `Reply to review ${String(item.answers)}`
			);
	}
}
