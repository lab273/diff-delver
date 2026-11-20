import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of pixels, such as how many differ between two images: zero or more. */
export type PixelCount = Tiny<number, 'PixelCount'>;

export interface InvalidPixelCount {
	readonly kind: 'InvalidPixelCount';
	readonly value: number;
}

export function parsePixelCount(value: number): Result<PixelCount, InvalidPixelCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidPixelCount', value });
	return ok(value as PixelCount);
}

/** One the code has just counted, which cannot be invalid, so a failure is a bug. */
export function pixelCountOf(value: number): PixelCount {
	const parsed = parsePixelCount(value);
	if (!parsed.ok) throw new RangeError(`Not a valid PixelCount: ${String(value)}`);
	return parsed.value;
}
