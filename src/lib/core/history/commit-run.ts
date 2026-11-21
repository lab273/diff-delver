/**
 * A run of commits as a diff's title names it (DESIGN 8.5): how many commits
 * it is, and the subjects of its oldest and newest, such as `3 commits: “Add a
 * discount rate” to “Say which code was used”`.
 *
 * A run is what ticking commits on the choose page opens (`commit-selection.ts`):
 * a single commit id, a range between two commit ids, or from git's empty tree to one. Ids never
 * come to name other commits, so what a run is made of is read once, when its
 * report is opened, and kept with the report.
 */
import { visibleText } from '../hidden-characters.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { formatCount } from '../viewer/words.ts';
import type { CommitCount } from './commit-count.tiny.ts';
import type { RunSubject } from './run-subject.tiny.ts';
import type { SubjectLine } from './subject-line.tiny.ts';

/** What is kept of a run of commits: enough to name it. */
export interface CommitRun {
	/** How many commits it is, along first parents from its newest to its oldest: at least one. */
	readonly commits: CommitCount;
	/** The subject of its oldest commit; of its only commit when it is one. */
	readonly oldest: RunSubject;
	readonly newest: RunSubject;
}

/** How long a subject may be in a sentence or a title before it is cut short. */
const SUBJECT_IN_SENTENCE = 60;

/** A subject as a sentence quotes it: with what cannot be seen written out, and cut short if long. */
export function quotedSubject(subject: SubjectLine | RunSubject): string {
	if (subject.trim() === '') return 'a commit with no message';
	const shown = visibleText(subject);
	let kept = '';
	let count = 0;
	for (const character of shown) {
		count += 1;
		if (count < SUBJECT_IN_SENTENCE) kept += character;
	}
	const cut = count > SUBJECT_IN_SENTENCE ? `${kept}…` : shown;
	return `“${cut}”`;
}

/**
 * A run of commits as a title: `3 commits: “Add a discount rate” to “Say which
 * code was used”`, two as `2 commits: “A” and “B”`, one as `1 commit: “A”`.
 * With `fromFirst`, the run starts at the repository's first commit, and says
 * so: `The first 3 commits: “Start the shop” to “Add prices”`.
 */
export function describeCommitRun(run: CommitRun, fromFirst: boolean): ReviewerMessage {
	const oldest = quotedSubject(run.oldest);
	const newest = quotedSubject(run.newest);
	if (run.commits <= 1) {
		return reviewerMessage(`${fromFirst ? 'The first commit' : '1 commit'}: ${newest}`);
	}
	const count = formatCount(run.commits);
	const many = fromFirst ? `The first ${count} commits` : `${count} commits`;
	return reviewerMessage(`${many}: ${oldest} ${run.commits === 2 ? 'and' : 'to'} ${newest}`);
}
