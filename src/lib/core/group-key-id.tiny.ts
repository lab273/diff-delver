import type { GroupKey } from './diff/slices.ts';
import type { Tiny } from './tiny.ts';

/**
 * A string that is equal for equal slice-group keys (`slices.ts`), for use as a
 * map key or an element id. Made only by `groupKeyId`, here.
 */
export type GroupKeyId = Tiny<string, 'GroupKeyId'>;

/** A string that is equal for equal group keys. */
export function groupKeyId(key: GroupKey): GroupKeyId {
	switch (key.kind) {
		case 'section':
			return `section:${key.section}` as GroupKeyId;
		case 'tests':
			return `tests:${key.section}` as GroupKeyId;
		case 'ignored':
			return 'ignored' as GroupKeyId;
		case 'uncategorised':
			return 'uncategorised' as GroupKeyId;
	}
}
