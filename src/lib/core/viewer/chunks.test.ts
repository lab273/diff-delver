import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunksOf } from './chunks.ts';

describe('chunks of rows', () => {
	it('cover every row once, in order, none longer than asked', () => {
		expect(chunksOf(0)).toEqual([]);
		expect(chunksOf(5, 2)).toEqual([
			{ first: 0, end: 2 },
			{ first: 2, end: 4 },
			{ first: 4, end: 5 }
		]);
		fc.assert(
			fc.property(fc.nat(2_000), fc.integer({ min: 1, max: 300 }), (count, size) => {
				const chunks = chunksOf(count, size);
				let next = 0;
				for (const chunk of chunks) {
					expect(chunk.first).toBe(next);
					expect(chunk.end - chunk.first).toBeGreaterThan(0);
					expect(chunk.end - chunk.first).toBeLessThanOrEqual(size);
					next = chunk.end;
				}
				expect(next).toBe(count);
			})
		);
	});
});
