import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of files, such as the files of a diff or those with units in a bucket. */
export type FileCount = Tiny<number, 'FileCount'>;

export interface InvalidFileCount {
	readonly kind: 'InvalidFileCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseFileCount(value: number): Result<FileCount, InvalidFileCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidFileCount', value });
	return ok(value as FileCount);
}

/** The size of a collection of files the code has just counted. A failure is a bug. */
export function fileCountOf(size: number): FileCount {
	const parsed = parseFileCount(size);
	if (!parsed.ok) throw new RangeError(`Not a count of files: ${size}`);
	return parsed.value;
}
