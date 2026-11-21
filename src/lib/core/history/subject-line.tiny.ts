import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A commit's subject as a list of commits shows it, from git's `%s`: text from
 * the repository, which may hold characters that cannot be seen, so it is shown
 * with them written out (`visiblePieces` in `hidden-characters.ts`). Unlike a
 * `CommitSubject` it may hold control characters, since a list must show every
 * commit, whatever its message holds.
 */
export type SubjectLine = Tiny<string, 'SubjectLine'>;

export interface InvalidSubjectLine {
	readonly kind: 'InvalidSubjectLine';
	readonly value: string;
}

/** Accepts one line of well-formed text, possibly empty. */
export function parseSubjectLine(value: string): Result<SubjectLine, InvalidSubjectLine> {
	if (value.includes('\n') || value.includes('\0') || !value.isWellFormed()) {
		return err({ kind: 'InvalidSubjectLine', value });
	}
	return ok(value as SubjectLine);
}
