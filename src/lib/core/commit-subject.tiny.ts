import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A commit's subject, its message's first line, as git gives it with `%s`. */
export type CommitSubject = Tiny<string, 'CommitSubject'>;

export interface InvalidCommitSubject {
	readonly kind: 'InvalidCommitSubject';
	readonly value: string;
}

/** Accepts one line of text with no control characters, which is what `%s` gives. */
export function parseCommitSubject(value: string): Result<CommitSubject, InvalidCommitSubject> {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return err({ kind: 'InvalidCommitSubject', value });
	}
	if (!value.isWellFormed()) return err({ kind: 'InvalidCommitSubject', value });
	return ok(value as CommitSubject);
}
