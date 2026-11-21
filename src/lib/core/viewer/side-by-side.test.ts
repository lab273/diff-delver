import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sideBySide, type LineSide } from './side-by-side.ts';

interface Line {
	readonly id: number;
	readonly side: LineSide;
}

const sideOf = (line: Line): LineSide => line.side;

function lines(sides: string): readonly Line[] {
	return Array.from({ length: sides.length }, (_, id) => sides.charAt(id)).map((c, id) => ({
		id,
		side: c === ' ' ? 'both' : c === '-' ? 'old' : 'new'
	}));
}

function shape(rows: ReturnType<typeof sideBySide<Line>>): string[] {
	return rows.map((r) => `${r.old?.id ?? '_'}|${r.new?.id ?? '_'}`);
}

describe('lines side by side', () => {
	it('pairs a removed run with the added run that replaces it, the extra beside nothing', () => {
		// unchanged, two removed, three added, unchanged, one removed, unchanged, one added
		expect(shape(sideBySide(lines(' --+++ - +'), sideOf))).toEqual([
			'0|0',
			'1|3',
			'2|4',
			'_|5',
			'6|6',
			'7|_',
			'8|8',
			'_|9'
		]);
	});

	it('never moves a removed line that follows added ones above them', () => {
		expect(shape(sideBySide(lines('+-'), sideOf))).toEqual(['_|0', '1|_']);
	});

	it('shows every line of the unified view once, on its side, in order', () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom<LineSide>('both', 'old', 'new'), { maxLength: 60 }),
				(sides) => {
					const unified: Line[] = sides.map((side, id) => ({ id, side }));
					const rows = sideBySide(unified, sideOf);
					const left = rows.flatMap((r) => (r.old === undefined ? [] : [r.old]));
					const right = rows.flatMap((r) => (r.new === undefined ? [] : [r.new]));
					// Each column is that side of the unified view, in its order.
					expect(left).toEqual(unified.filter((l) => l.side !== 'new'));
					expect(right).toEqual(unified.filter((l) => l.side !== 'old'));
					// An unchanged line is beside itself; a change is never beside an unchanged line.
					for (const row of rows) {
						if (row.old?.side === 'both' || row.new?.side === 'both') expect(row.old).toBe(row.new);
						expect(row.old !== undefined || row.new !== undefined).toBe(true);
					}
					// Read row by row, both columns together, the lines come in the unified order.
					const firstOf = (r: (typeof rows)[number]) =>
						Math.min(r.old?.id ?? Infinity, r.new?.id ?? Infinity);
					const order = rows.map(firstOf);
					expect([...order].sort((a, b) => a - b)).toEqual(order);
				}
			)
		);
	});
});
