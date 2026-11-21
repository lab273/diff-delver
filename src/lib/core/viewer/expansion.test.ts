import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineNumberOf } from '../line-number.tiny.ts';
import {
	afterOpening,
	EXPANSION_STEP,
	linesToOpen,
	stillHidden,
	type Direction,
	type Opened
} from './expansion.ts';

function span(first: number, last: number): Opened {
	return { span: { first: lineNumberOf(first), last: lineNumberOf(last) }, top: 0, bottom: 0 };
}

describe('opening hidden lines', () => {
	it('opens a step downwards, a step upwards, then the rest', () => {
		let opened = span(10, 60);
		expect(linesToOpen(opened, 'down')).toEqual({ first: 10, last: 29 });
		opened = afterOpening(opened, 'down', EXPANSION_STEP);
		expect(linesToOpen(opened, 'up')).toEqual({ first: 41, last: 60 });
		opened = afterOpening(opened, 'up', EXPANSION_STEP);
		expect(stillHidden(opened)).toBe(11);
		expect(linesToOpen(opened, 'all')).toEqual({ first: 30, last: 40 });
		opened = afterOpening(opened, 'all', 11);
		expect(stillHidden(opened)).toBe(0);
		expect(linesToOpen(opened, 'down')).toBeUndefined();
	});

	it('never opens a line twice nor past the hidden lines, in any order of steps', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 200 }),
				fc.integer({ min: 0, max: 120 }),
				fc.array(fc.constantFrom<Direction>('down', 'up', 'all'), { maxLength: 12 }),
				(first, length, steps) => {
					let opened = span(first, first + length);
					const seen = new Set<number>();
					for (const step of steps) {
						const lines = linesToOpen(opened, step);
						if (lines === undefined) {
							expect(stillHidden(opened)).toBe(0);
							continue;
						}
						for (let n: number = lines.first; n <= lines.last; n += 1) {
							expect(seen.has(n)).toBe(false);
							expect(n >= first && n <= first + length).toBe(true);
							seen.add(n);
						}
						opened = afterOpening(opened, step, lines.last - lines.first + 1);
					}
					expect(seen.size + stillHidden(opened)).toBe(length + 1);
				}
			)
		);
	});
});
