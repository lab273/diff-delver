import { describe, expect, it } from 'vitest';
import { millisecondsOf, parseMilliseconds } from './milliseconds.tiny.ts';

describe('parseMilliseconds', () => {
	it.each([0, 0.25, 1_000, 3.6e6])('accepts %d', (value) => {
		expect(parseMilliseconds(value)).toEqual({ ok: true, value });
	});

	it.each([-0.001, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d', (value) => {
		expect(parseMilliseconds(value)).toEqual({
			ok: false,
			error: { kind: 'InvalidMilliseconds', value }
		});
	});

	it('treats a time that cannot be one as a bug', () => {
		expect(millisecondsOf(5)).toBe(5);
		expect(() => millisecondsOf(-1)).toThrow(RangeError);
	});
});
