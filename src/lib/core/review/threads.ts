/**
 * Threads (DESIGN 5, 6.3): what a finished review's comments and flags
 * become. A thread belongs to the Delve, not to a review: it is followed to
 * its lines in every later version (`core/update/reanchor.ts`), and each
 * message in it belongs to the review it was written in. In a later version
 * it is open, its code changed since, or resolved; the reviewer replies to it
 * or resolves or reopens it, and that is part of the draft, finished with the
 * next review. Pure: its status, and its words.
 */
import type { LineText } from '../line-text.tiny.ts';
import type { ReviewNumber } from '../review-number.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { ThreadId } from '../thread-id.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { countOf } from '../viewer/words.ts';
import type { CommentAnchor, ThreadKind } from './draft-comment.ts';

/**
 * Where a thread stands in a version: open; its code changed since anything
 * was last said or done on it, so it may have been dealt with; or resolved.
 */
export type ThreadStatus = 'open' | 'changed' | 'resolved';

/** What the page calls each status (DESIGN 8.5). */
export function threadStatusWords(status: ThreadStatus): string {
	switch (status) {
		case 'open':
			return 'Open';
		case 'changed':
			return 'Code changed since';
		case 'resolved':
			return 'Resolved';
	}
}

/** One message of a thread: a finished review's comment or flag, or a reply to it. */
export interface ThreadMessage {
	/** The review it was finished in. */
	readonly review: ReviewNumber;
	readonly kind: ThreadKind;
	/** The version its lines were in. */
	readonly version: RevisionNumber;
	readonly anchor: CommentAnchor;
	/** The reviewer's words, exactly as typed; a flag's may be ''. */
	readonly body: string;
	readonly writtenAt: Timestamp;
}

/** A thread resolved, or opened again, in a finished review. */
export interface ThreadResolution {
	readonly review: ReviewNumber;
	readonly resolved: boolean;
	/** The version it was done on. */
	readonly version: RevisionNumber;
}

/** A thread's lines in one version, as it was followed there: undefined when they are gone. */
export interface ThreadPlace {
	readonly version: RevisionNumber;
	readonly anchor: CommentAnchor | undefined;
	/** Whether its code changed between the version it was followed from and this one. */
	readonly edited: boolean;
}

/** A thread of a Delve, as a version shows it. */
export interface EarlierThread {
	readonly id: ThreadId;
	/** Its first message's kind: a comment or a flag. */
	readonly kind: ThreadKind;
	/** Oldest first; the first is the comment or flag that started it. */
	readonly messages: readonly ThreadMessage[];
	/** The code its first message was on, as that review quoted it: none for a flag. */
	readonly quoted: readonly LineText[];
	/** Its lines in the version shown; undefined when they are gone from it. */
	readonly at: CommentAnchor | undefined;
	readonly status: ThreadStatus;
}

/** The first message of a thread: the comment or flag that started it. */
export function startOf(thread: Pick<EarlierThread, 'messages'>): ThreadMessage | undefined {
	return thread.messages[0];
}

/**
 * A thread's status in version `shown`: resolved when the last finished
 * review that resolved or opened it again resolved it; else changed when its
 * code changed in a version after the last one anything was said or done on
 * it, up to `shown`; else open.
 */
export function threadStatus(
	messages: readonly Pick<ThreadMessage, 'version'>[],
	resolutions: readonly ThreadResolution[],
	places: readonly ThreadPlace[],
	shown: RevisionNumber
): ThreadStatus {
	const last = resolutions.reduce<ThreadResolution | undefined>(
		(latest, r) => (latest === undefined || r.review > latest.review ? r : latest),
		undefined
	);
	if (last?.resolved === true) return 'resolved';
	const since = Math.max(...messages.map((m) => m.version), ...resolutions.map((r) => r.version));
	const changed = places.some((p) => p.edited && p.version > since && p.version <= shown);
	return changed ? 'changed' : 'open';
}

/** How many of some threads have each status. */
export function threadCounts(threads: readonly Pick<EarlierThread, 'status'>[]): {
	readonly open: number;
	readonly changed: number;
	readonly resolved: number;
} {
	let open = 0;
	let changed = 0;
	let resolved = 0;
	for (const t of threads) {
		switch (t.status) {
			case 'open':
				open += 1;
				break;
			case 'changed':
				changed += 1;
				break;
			case 'resolved':
				resolved += 1;
				break;
		}
	}
	return { open, changed, resolved };
}

/** The list's heading in words: "From earlier reviews: 3 open, 1 code changed since". */
export function describeEarlierThreads(
	threads: readonly Pick<EarlierThread, 'status'>[]
): ReviewerMessage {
	const { open, changed, resolved } = threadCounts(threads);
	const parts = [
		...(open > 0 ? [`${String(open)} open`] : []),
		...(changed > 0 ? [`${String(changed)} code changed since`] : []),
		...(resolved > 0 ? [`${String(resolved)} resolved`] : [])
	];
	return reviewerMessage(
		parts.length === 0 ? 'From earlier reviews: none' : `From earlier reviews: ${parts.join(', ')}`
	);
}

/** Where a thread came from, in words: "Comment from review 1", "Flag from review 2". */
export function describeThreadStart(thread: Pick<EarlierThread, 'kind' | 'messages'>): string {
	const start = startOf(thread);
	const what = thread.kind === 'flag' ? 'Flag' : 'Comment';
	return start === undefined ? what : `${what} from review ${String(start.review)}`;
}

/** How many replies a thread has, in words: "2 replies", or '' for none. */
export function describeReplies(thread: Pick<EarlierThread, 'messages'>): string {
	const replies = thread.messages.length - 1;
	return replies <= 0 ? '' : countOf(replies, 'reply', 'replies');
}
