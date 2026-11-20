/**
 * What an update did to a diff (DESIGN 6.2, 8.1), in counts and in plain words:
 * how many files changed, how many changes are new to review, how many are no
 * longer in the diff, and how much of what the reviewer had marked as reviewed
 * is still marked. A page keeps saying it after a reload, so it is stored with
 * the version it made.
 */
import type { FileCount } from '../file-count.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { UnitCount } from '../unit-count.tiny.ts';

export interface UpdateSummary {
	/**
	 * Files whose change is not what it was: new to the diff, with changes new to
	 * review, with changes gone, or gone from the diff altogether.
	 */
	readonly filesChanged: FileCount;
	/** Of those, the files of the previous version that are no longer in the diff. */
	readonly filesGone: FileCount;
	/** Changes with no match in the previous version, outside Ignored: what is new to review. */
	readonly newToReview: UnitCount;
	/** Changes with no match in the previous version that a built-in rule or pattern ignored. */
	readonly newIgnored: UnitCount;
	/** Changes of the previous version with no match in this one. */
	readonly gone: UnitCount;
	/** How many changes of the previous version were marked as reviewed. */
	readonly reviewedBefore: UnitCount;
	/** How many of those marks were carried over; never more than `reviewedBefore`. */
	readonly reviewedKept: UnitCount;
}

function plural(count: number, one: string, many: string): string {
	return `${String(count)} ${count === 1 ? one : many}`;
}

/** What the files' changes became, as the first sentence of the update's message. */
export function describeChangedFiles(summary: UpdateSummary): ReviewerMessage {
	if (summary.filesChanged === 0) {
		return reviewerMessage(
			'Nothing in the diff changed: the files that changed are outside what it compares.'
		);
	}
	const parts = [
		summary.newToReview === 0
			? 'nothing new to review'
			: `${plural(summary.newToReview, 'change', 'changes')} new to review`
	];
	if (summary.gone > 0) {
		parts.push(`${plural(summary.gone, 'change', 'changes')} no longer in the diff`);
	}
	if (summary.newIgnored > 0) {
		parts.push(`${plural(summary.newIgnored, 'new change', 'new changes')} ignored`);
	}
	const last = parts.pop() ?? '';
	const listed = parts.length === 0 ? last : `${parts.join(', ')} and ${last}`;
	return reviewerMessage(`${plural(summary.filesChanged, 'file', 'files')} changed: ${listed}.`);
}

/** What became of the reviewer's marks, as a sentence; undefined when there were none. */
export function describeKeptMarks(summary: UpdateSummary): ReviewerMessage | undefined {
	const before = summary.reviewedBefore;
	const kept = summary.reviewedKept;
	if (before === 0) return undefined;
	if (kept === before) {
		return reviewerMessage(
			before === 1
				? 'The change you had marked as reviewed is still marked.'
				: `All ${String(before)} changes you had marked as reviewed are still marked.`
		);
	}
	const other = before - kept;
	const lost =
		other === 1
			? 'the other one could not be matched to the files as they are now, so it needs another look'
			: `the other ${String(other)} could not be matched to the files as they are now, so they need another look`;
	if (kept === 0) {
		return reviewerMessage(
			before === 1
				? 'The change you had marked as reviewed could not be matched to the files as they are now, so it needs another look.'
				: `None of the ${String(before)} changes you had marked as reviewed could be matched to the files as they are now, so they need another look.`
		);
	}
	return reviewerMessage(
		`${String(kept)} of the ${String(before)} changes you had marked as reviewed ${kept === 1 ? 'is' : 'are'} still marked; ${lost}.`
	);
}

/** The whole message: what changed, then what became of the marks. */
export function describeUpdate(summary: UpdateSummary): ReviewerMessage {
	const marks = describeKeptMarks(summary);
	const changed = describeChangedFiles(summary);
	return marks === undefined ? changed : reviewerMessage(`${changed} ${marks}`);
}
