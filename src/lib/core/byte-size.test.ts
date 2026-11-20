import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseByteSize } from './byte-size.tiny.ts';

describe('parseByteSize', () => {
	it('accepts an empty file', () => {
		expect(parseByteSize(0)).toEqual({ ok: true, value: 0 });
	});

	it.each([-1, 0.5, Number.NaN])('rejects %d', (value) => {
		expect(parseByteSize(value)).toEqual({ ok: false, error: { kind: 'InvalidByteSize', value } });
	});

	it('accepts every whole number from zero up', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (value) => {
				expect(parseByteSize(value)).toEqual({ ok: true, value });
			})
		);
	});
});
