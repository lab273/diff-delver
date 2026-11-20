import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A size in bytes, such as a snapshot's share of the store. */
export type ByteSize = Tiny<number, 'ByteSize'>;

export interface InvalidByteSize {
	readonly kind: 'InvalidByteSize';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseByteSize(value: number): Result<ByteSize, InvalidByteSize> {
	if (!Number.isSafeInteger(value) || value < 0) {
		return err({ kind: 'InvalidByteSize', value });
	}
	return ok(value as ByteSize);
}
