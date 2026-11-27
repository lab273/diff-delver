import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * One thread of a Delve (DESIGN 6.3), as the database numbers it: a whole
 * number of 1 or more, never given to another thread.
 */
export type ThreadId = Tiny<number, 'ThreadId'>;

export interface InvalidThreadId {
	readonly kind: 'InvalidThreadId';
	readonly value: number;
}

export function parseThreadId(value: number): Result<ThreadId, InvalidThreadId> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidThreadId', value });
	return ok(value as ThreadId);
}
