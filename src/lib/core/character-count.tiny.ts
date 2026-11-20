import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A length in characters (UTF-16 code units, as JavaScript counts them), such as a line-length limit. */
export type CharacterCount = Tiny<number, 'CharacterCount'>;

export interface InvalidCharacterCount {
	readonly kind: 'InvalidCharacterCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseCharacterCount(value: number): Result<CharacterCount, InvalidCharacterCount> {
	if (!Number.isSafeInteger(value) || value < 0) {
		return err({ kind: 'InvalidCharacterCount', value });
	}
	return ok(value as CharacterCount);
}

/** A length the code knows is valid, such as a constant. A failure is a bug. */
export function characterCount(value: number): CharacterCount {
	const parsed = parseCharacterCount(value);
	if (!parsed.ok) throw new RangeError(`Not a character count: ${value}`);
	return parsed.value;
}
