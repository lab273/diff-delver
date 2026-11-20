import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseLineNumber } from './line-number.tiny.ts';

describe('parseLineNumber', () => {
	it('accepts the first line', () => {
		expect(parseLineNumber(1)).toEqual({ ok: true, value: 1 });
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects %d', (value) => {
		expect(parseLineNumber(value)).toEqual({
			ok: false,
			error: { kind: 'InvalidLineNumber', value }
		});
	});

	it('accepts exactly the positive whole numbers, unchanged', () => {
		fc.assert(
			fc.property(fc.oneof(fc.integer(), fc.double()), (value) => {
				const result = parseLineNumber(value);
				expect(result.ok).toBe(Number.isSafeInteger(value) && value >= 1);
				if (result.ok) expect(result.value).toBe(value);
			})
		);
	});
});
