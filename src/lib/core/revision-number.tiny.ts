import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A revision's place within its report: 1, 2, 3, as the reviewer sees it ("revision 2"). */
export type RevisionNumber = Tiny<number, 'RevisionNumber'>;

export interface InvalidRevisionNumber {
	readonly kind: 'InvalidRevisionNumber';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parseRevisionNumber(value: number): Result<RevisionNumber, InvalidRevisionNumber> {
	if (!Number.isSafeInteger(value) || value < 1) {
		return err({ kind: 'InvalidRevisionNumber', value });
	}
	return ok(value as RevisionNumber);
}

/** A report's first revision. */
export const FIRST_REVISION = 1 as RevisionNumber;

/** The revision after this one. */
export function nextRevisionNumber(number: RevisionNumber): RevisionNumber {
	return (number + 1) as RevisionNumber;
}
