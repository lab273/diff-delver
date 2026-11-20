import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A 1-based line number in a file. */
export type LineNumber = Tiny<number, 'LineNumber'>;

export interface InvalidLineNumber {
	readonly kind: 'InvalidLineNumber';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parseLineNumber(value: number): Result<LineNumber, InvalidLineNumber> {
	if (!Number.isSafeInteger(value) || value < 1) {
		return err({ kind: 'InvalidLineNumber', value });
	}
	return ok(value as LineNumber);
}
