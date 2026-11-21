import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';
import type { SubjectLine } from './subject-line.tiny.ts';

/**
 * A commit's subject as a run of commits keeps it, stored with the report it
 * titles: one line of well-formed text of at most `RUN_SUBJECT_LENGTH`
 * characters, the rest of a longer subject cut off. Text from the repository,
 * so it is shown with what cannot be seen written out, as a `SubjectLine` is.
 */
export type RunSubject = Tiny<string, 'RunSubject'>;

/** How many characters of a subject are kept: far more than a title shows, and never a whole essay. */
export const RUN_SUBJECT_LENGTH = 200;

export interface InvalidRunSubject {
	readonly kind: 'InvalidRunSubject';
	readonly value: string;
}

/**
 * The first `RUN_SUBJECT_LENGTH` characters of `text`, and whether it has more.
 * Characters, not units of length: one outside the basic plane is two units,
 * and is never cut in half.
 */
function firstCharacters(text: string): { readonly kept: string; readonly more: boolean } {
	let kept = '';
	let count = 0;
	for (const character of text) {
		if (count === RUN_SUBJECT_LENGTH) return { kept, more: true };
		kept += character;
		count += 1;
	}
	return { kept, more: false };
}

/** Accepts one line of well-formed text, possibly empty, of at most `RUN_SUBJECT_LENGTH` characters. */
export function parseRunSubject(value: string): Result<RunSubject, InvalidRunSubject> {
	const valid =
		!value.includes('\n') &&
		!value.includes('\0') &&
		value.isWellFormed() &&
		!firstCharacters(value).more;
	return valid ? ok(value as RunSubject) : err({ kind: 'InvalidRunSubject', value });
}

/** A subject as a run keeps it: its first `RUN_SUBJECT_LENGTH` characters. */
export function runSubjectOf(subject: SubjectLine): RunSubject {
	return firstCharacters(subject).kept as RunSubject;
}
