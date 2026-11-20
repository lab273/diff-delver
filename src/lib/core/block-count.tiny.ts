import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** How many blocks of code ran, as V8 counts them: a whole number of zero or more. */
export type BlockCount = Tiny<number, 'BlockCount'>;

export interface InvalidBlockCount {
	readonly kind: 'InvalidBlockCount';
	readonly value: number;
}

export function parseBlockCount(value: number): Result<BlockCount, InvalidBlockCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidBlockCount', value });
	return ok(value as BlockCount);
}
