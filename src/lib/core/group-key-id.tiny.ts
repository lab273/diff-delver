import type { Tiny } from './tiny.ts';

/**
 * A string that is equal for equal slice-group keys (`slices.ts`), for use as a
 * map key or an element id. Made only by `groupKeyId`.
 */
export type GroupKeyId = Tiny<string, 'GroupKeyId'>;

export function groupKeyIdFrom(text: string): GroupKeyId {
	return text as GroupKeyId;
}
