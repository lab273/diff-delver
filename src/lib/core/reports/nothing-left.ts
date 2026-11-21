/**
 * What a report's page says when its source has nothing left to review
 * (DESIGN 6.1): what most likely happened, in plain words, and what to open
 * instead, such as the commit the changes went into. The report itself stays
 * open and readable until the reviewer closes it.
 */
import type { CommitId } from '../commit-id.tiny.ts';
import type { CommitSubject } from '../commit-subject.tiny.ts';
import { parseRevision, type Revision } from '../revision.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import {
	revisionInWords,
	shortRevisionName,
	type GitSourceSpec
} from '../sources/git-source-spec.ts';

/**
 * Where uncommitted or staged changes went, as the repository shows it now,
 * judged from the commit they were made on (the revision's base) and HEAD.
 */
export type CommitsSince =
	/** It cannot be told: HEAD is not a descendant of the base, or there was no base. */
	| { readonly kind: 'unknown' }
	/** HEAD is still the base: nothing was committed, so the changes were discarded or stashed. */
	| { readonly kind: 'none' }
	/** One commit was made on top of the base. */
	| { readonly kind: 'one'; readonly commit: CommitId; readonly subject: CommitSubject | undefined }
	/** Several commits were made on top of the base, up to `head`. */
	| { readonly kind: 'several'; readonly base: CommitId; readonly head: CommitId };

/** A source to offer instead, with what the offer says. */
export interface NextSource {
	readonly spec: GitSourceSpec;
	/** The offer, as a button or link says it: "Review commit 1a2b3c4, “Add sign-in”". */
	readonly offer: ReviewerMessage;
}

export interface NothingLeft {
	/** What happened, in a sentence. */
	readonly reason: ReviewerMessage;
	/** What to open instead, when it can be told. */
	readonly next: NextSource | undefined;
}

function revisionOf(commit: CommitId): Revision {
	const revision = parseRevision(commit);
	if (!revision.ok) throw new Error(`A commit id is not a revision: ${commit}`);
	return revision.value;
}

function short(commit: CommitId): string {
	return shortRevisionName(revisionOf(commit));
}

/** What to say, and offer, when a report's source has nothing left to review. */
export function nothingLeft(spec: GitSourceSpec, since: CommitsSince): NothingLeft {
	switch (spec.kind) {
		case 'working-tree':
		case 'staged':
			return uncommittedNothingLeft(spec.kind, since);
		case 'commit':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: ${revisionInWords(spec.revision)} now names a commit that changes no files. What you were reading is still shown.`
				),
				next: undefined
			};
		case 'range':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: ${revisionInWords(spec.to)} has no changes compared with ${revisionInWords(spec.from)} any more, most likely because it was merged. What you were reading is still shown.`
				),
				next: undefined
			};
	}
}

function uncommittedNothingLeft(kind: 'working-tree' | 'staged', since: CommitsSince): NothingLeft {
	const what = kind === 'working-tree' ? 'uncommitted changes' : 'staged changes';
	const shown = 'What you were reading is still shown.';
	switch (since.kind) {
		case 'one': {
			const named =
				since.subject === undefined
					? `commit ${short(since.commit)}`
					: `commit ${short(since.commit)}, “${since.subject}”`;
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: the ${what} have most likely been committed, in ${named}. ${shown}`
				),
				next: {
					spec: { kind: 'commit', revision: revisionOf(since.commit) },
					offer: reviewerMessage(`Review ${named}`)
				}
			};
		}
		case 'several':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: the ${what} have most likely been committed, in the commits made since, up to ${short(since.head)}. ${shown}`
				),
				next: {
					spec: { kind: 'range', from: revisionOf(since.base), to: revisionOf(since.head) },
					offer: reviewerMessage(
						`Review the commits made since, ${short(since.base)} to ${short(since.head)}`
					)
				}
			};
		case 'none':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: there are no ${what} any more and nothing has been committed, so they were most likely discarded or stashed. ${shown}`
				),
				next: undefined
			};
		case 'unknown':
			return {
				reason: reviewerMessage(
					`Nothing is left to review here: there are no ${what} any more. They may have been committed, merged or discarded. ${shown}`
				),
				next: undefined
			};
	}
}
