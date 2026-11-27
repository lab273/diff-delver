import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineNumberOf } from '../line-number.tiny.ts';
import { parseRevisionNumber } from '../revision-number.tiny.ts';
import type { Side } from '../side.tiny.ts';
import {
	byLastLine,
	describeOtherVersion,
	inSelection,
	lineKey,
	selectionBetween,
	type LineSelection
} from './comment-places.ts';

function version(n: number) {
	const parsed = parseRevisionNumber(n);
	if (!parsed.ok) throw new Error('not a version');
	return parsed.value;
}

const side = fc.constantFrom<Side>('old', 'new');
const line = fc.integer({ min: 1, max: 5000 }).map(lineNumberOf);

describe('a selection of lines', () => {
	it('is the same run whichever way it was made', () => {
		fc.assert(
			fc.property(side, line, line, (on, from, to) => {
				const there = selectionBetween(on, from, to);
				expect(there).toEqual(selectionBetween(on, to, from));
				expect(there.first).toBeLessThanOrEqual(there.last);
				expect(there.side).toBe(on);
				expect(inSelection(there, on, from)).toBe(true);
				expect(inSelection(there, on, to)).toBe(true);
			})
		);
	});

	it('holds only its own lines, on its own side', () => {
		const there = selectionBetween('new', lineNumberOf(7), lineNumberOf(4));
		expect([3, 4, 5, 6, 7, 8].map((n) => inSelection(there, 'new', lineNumberOf(n)))).toEqual([
			false,
			true,
			true,
			true,
			true,
			false
		]);
		expect(inSelection(there, 'old', lineNumberOf(5))).toBe(false);
		expect(inSelection(undefined, 'new', lineNumberOf(5))).toBe(false);
	});
});

describe('comments among a file’s lines', () => {
	const at = (on: Side, first: number, last: number): LineSelection => ({
		side: on,
		first: lineNumberOf(first),
		last: lineNumberOf(last)
	});

	it('are each under the last line of their range, on their side, in order', () => {
		const comments = [
			{ name: 'a', lines: at('new', 3, 5) },
			{ name: 'b', lines: at('old', 5, 5) },
			{ name: 'c', lines: at('new', 5, 5) },
			{ name: 'd', lines: at('new', 1, 1) }
		];
		const found = byLastLine(comments, (comment) => comment.lines);
		const names = (key: string) => found.get(key)?.map((comment) => comment.name);
		expect(names(lineKey('new', lineNumberOf(5)))).toEqual(['a', 'c']);
		expect(names(lineKey('old', lineNumberOf(5)))).toEqual(['b']);
		expect(names(lineKey('new', lineNumberOf(1)))).toEqual(['d']);
		expect(names(lineKey('new', lineNumberOf(3)))).toBeUndefined();
		expect(found.size).toBe(3);
		expect(byLastLine([], (comment: (typeof comments)[number]) => comment.lines).size).toBe(0);
	});

	it('loses none and draws none twice', () => {
		fc.assert(
			fc.property(fc.array(fc.tuple(side, line, line)), (given) => {
				const comments = given.map(([on, from, to]) => selectionBetween(on, from, to));
				const found = byLastLine(comments, (comment) => comment);
				expect([...found.values()].flat()).toHaveLength(comments.length);
				for (const [key, there] of found) {
					for (const comment of there) expect(lineKey(comment.side, comment.last)).toBe(key);
				}
			})
		);
	});

	it('says in plain words when a comment’s lines are in another version', () => {
		expect(describeOtherVersion(version(2), version(2))).toBeUndefined();
		expect(describeOtherVersion(version(1), version(3))).toBe(
			'Written on version 1, an earlier version than the one shown here, so it is not among the lines of the diff.'
		);
		expect(describeOtherVersion(version(3), version(2))).toMatch(/a newer version/);
	});
});
