/**
 * What the page counts of the changes it hides for only changing white space:
 * a part's own, never another group's drawn muted in it, the same in the
 * part's notice and in a hunk's.
 */
import { describe, expect, it } from 'vitest';
import type { ShownLineView } from '#lib/api/schemas.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseLineText, type LineText } from '#lib/core/line-text.tiny.ts';
import { quietWhiteSpace, type Quieted } from '#lib/core/viewer/white-space.ts';
import type { GroupKeyView } from '#lib/api/schemas.ts';
import { groupKeyId } from '#lib/core/group-key-id.tiny.ts';
import { hiddenIn, wholeHunkHidden } from './white-space-notice.ts';

function text(value: string): LineText {
	const parsed = parseLineText(value);
	if (!parsed.ok) throw new Error(value);
	return parsed.value;
}

const IGNORED: GroupKeyView = { kind: 'ignored' };

type Home = 'here' | 'elsewhere';

function removed(n: number, value: string, home: Home = 'here'): ShownLineView {
	return {
		kind: 'deleted',
		old: lineNumberOf(n),
		text: text(value),
		noNewlineAtEnd: false,
		home: home === 'here' ? { kind: 'here', fresh: false } : { kind: 'elsewhere', group: IGNORED }
	};
}

function added(n: number, value: string, home: Home = 'here'): ShownLineView {
	return {
		kind: 'added',
		new: lineNumberOf(n),
		text: text(value),
		noNewlineAtEnd: false,
		home: home === 'here' ? { kind: 'here', fresh: false } : { kind: 'elsewhere', group: IGNORED }
	};
}

function context(n: number, value: string): ShownLineView {
	return {
		kind: 'context',
		old: lineNumberOf(n),
		new: lineNumberOf(n),
		text: text(value),
		noNewlineAtEnd: false
	};
}

/** As the viewer draws a hunk with white space hidden. */
function drawn(lines: readonly ShownLineView[]): readonly Quieted<ShownLineView>[] {
	return quietWhiteSpace(lines, (line) => ({
		kind: line.kind,
		text: line.text,
		group: line.kind === 'context' || line.home.kind === 'here' ? '' : groupKeyId(line.home.group)
	}));
}

describe('counting the white-space changes a part hides', () => {
	it('counts only the part’s own changes, in a hunk as in the part', () => {
		const hunk = drawn([
			context(1, 'a'),
			removed(2, 'b'),
			removed(3, 'c', 'elsewhere'),
			added(2, '  b'),
			added(3, '  c', 'elsewhere'),
			context(4, 'd')
		]);
		expect(hiddenIn(hunk)).toBe(2);
		expect(wholeHunkHidden(hunk)).toBe(2);
	});

	it('draws a hunk whose hidden changes are all another group’s as it is', () => {
		const hunk = drawn([removed(3, 'c', 'elsewhere'), added(3, '  c', 'elsewhere')]);
		expect(hiddenIn(hunk)).toBe(0);
		expect(wholeHunkHidden(hunk)).toBeUndefined();
	});

	it('draws a hunk with a change left to see as it is', () => {
		const hunk = drawn([removed(2, 'b'), added(2, '  b'), added(3, 'new')]);
		expect(hiddenIn(hunk)).toBe(2);
		expect(wholeHunkHidden(hunk)).toBeUndefined();
	});
});
