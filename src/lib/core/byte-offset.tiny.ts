import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A 0-based position in a run of bytes, such as git's output. */
export type ByteOffset = Tiny<number, 'ByteOffset'>;

export interface InvalidByteOffset {
	readonly kind: 'InvalidByteOffset';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseByteOffset(value: number): Result<ByteOffset, InvalidByteOffset> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidByteOffset', value });
	return ok(value as ByteOffset);
}

/** The offset the code is reading at. A failure is a bug. */
export function byteOffsetAt(value: number): ByteOffset {
	const parsed = parseByteOffset(value);
	if (!parsed.ok) throw new RangeError(`Not a byte offset: ${value}`);
	return parsed.value;
}
