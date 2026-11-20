import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** The 0-based position of an item in a request, such as one `assign` item. */
export type ItemIndex = Tiny<number, 'ItemIndex'>;

export interface InvalidItemIndex {
	readonly kind: 'InvalidItemIndex';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseItemIndex(value: number): Result<ItemIndex, InvalidItemIndex> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidItemIndex', value });
	return ok(value as ItemIndex);
}

/** The index of an element the code is iterating over. A failure is a bug. */
export function itemIndexAt(index: number): ItemIndex {
	const parsed = parseItemIndex(index);
	if (!parsed.ok) throw new RangeError(`Not an item index: ${index}`);
	return parsed.value;
}
