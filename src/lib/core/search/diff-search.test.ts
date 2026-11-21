import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countInPart, DiffSearchIndex, type SearchedPart } from './diff-search.ts';
import { parseSearchText, type SearchText } from './search-text.tiny.ts';

function query(text: string): SearchText {
	const parsed = parseSearchText(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const parts: readonly SearchedPart[] = [
	{
		path: 'src/Total.ts',
		lines: [
			{ text: 'const total = 1;', changed: false },
			{ text: 'const total = 2;', changed: true }
		]
	},
	{ path: 'docs/readme.md', lines: [{ text: 'Totals', changed: true }] },
	{ path: 'other.ts', lines: [] }
];

describe('searching a diff', () => {
	it('counts matches in paths and lines, with each option', () => {
		const index = new DiffSearchIndex(parts);
		const total = query('total');
		expect(index.counts(total, { matchCase: false, changedOnly: false })).toEqual([3, 1, 0]);
		expect(index.counts(total, { matchCase: true, changedOnly: false })).toEqual([2, 0, 0]);
		// Paths are searched with changed lines only, too.
		expect(index.counts(total, { matchCase: false, changedOnly: true })).toEqual([2, 1, 0]);
	});

	it('counts each part as countInPart does, however often it is searched', () => {
		const line = fc.record({ text: fc.string({ maxLength: 12 }), changed: fc.boolean() });
		const part = fc.record({
			path: fc.string({ maxLength: 10 }),
			lines: fc.array(line, { maxLength: 5 })
		});
		fc.assert(
			fc.property(
				fc.array(part, { maxLength: 5 }),
				fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 2 }), fc.boolean(), fc.boolean()), {
					minLength: 1,
					maxLength: 3
				}),
				(searched, queries) => {
					const index = new DiffSearchIndex(searched);
					for (const [text, matchCase, changedOnly] of queries) {
						const q = parseSearchText(text);
						if (!q.ok) continue;
						const options = { matchCase, changedOnly };
						expect(index.counts(q.value, options)).toEqual(
							searched.map((p) => countInPart(p, q.value, options))
						);
					}
				}
			)
		);
	});
});
