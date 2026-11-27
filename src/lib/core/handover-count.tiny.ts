import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** How many times a finished review was handed over one way: one or more. */
export type HandoverCount = Tiny<number, 'HandoverCount'>;

export interface InvalidHandoverCount {
	readonly kind: 'InvalidHandoverCount';
	readonly value: number;
}

export function parseHandoverCount(value: number): Result<HandoverCount, InvalidHandoverCount> {
	if (!Number.isSafeInteger(value) || value < 1)
		return err({ kind: 'InvalidHandoverCount', value });
	return ok(value as HandoverCount);
}
