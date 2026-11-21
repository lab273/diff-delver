/**
 * A group of a view written as text, as an address names it: `uncategorised`,
 * `ignored`, `section:session-expiry`, `tests:session-expiry`, the form
 * `groupKeyId` writes. Read back here, at the edge.
 */
import type { GroupKey } from '../diff/slices.ts';
import { err, ok, type Result } from '../result.ts';
import { parseSectionId } from '../section-id.tiny.ts';

export interface InvalidGroupText {
	readonly kind: 'InvalidGroupText';
	readonly value: string;
}

export function parseGroupText(value: string): Result<GroupKey, InvalidGroupText> {
	if (value === 'ignored') return ok({ kind: 'ignored' });
	if (value === 'uncategorised') return ok({ kind: 'uncategorised' });
	const colon = value.indexOf(':');
	const kind = value.slice(0, colon);
	const section = parseSectionId(value.slice(colon + 1));
	if (colon < 0 || !section.ok) return err({ kind: 'InvalidGroupText', value });
	if (kind === 'section') return ok({ kind: 'section', section: section.value });
	if (kind === 'tests') return ok({ kind: 'tests', section: section.value });
	return err({ kind: 'InvalidGroupText', value });
}
