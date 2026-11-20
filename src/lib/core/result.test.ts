import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { andThen, err, map, mapErr, ok, unwrapOr, type Result } from './result.ts';

const half = (n: number): Result<number, 'odd'> => (n % 2 === 0 ? ok(n / 2) : err('odd'));

describe('Result', () => {
	it('maps a success and passes a failure through', () => {
		expect(map(ok(2), (n) => n + 1)).toEqual(ok(3));
		expect(map(err('no'), (n: number) => n + 1)).toEqual(err('no'));
	});

	it('chains steps that can fail', () => {
		expect(andThen(ok(8), half)).toEqual(ok(4));
		expect(andThen(ok(3), half)).toEqual(err('odd'));
		expect(andThen(err('earlier'), half)).toEqual(err('earlier'));
	});

	it('maps an error and passes a success through', () => {
		expect(mapErr(err('no'), (e) => e.length)).toEqual(err(2));
		expect(mapErr(ok(1), (e: string) => e.length)).toEqual(ok(1));
	});

	it('falls back only on failure', () => {
		expect(unwrapOr(ok(1), 0)).toBe(1);
		expect(unwrapOr(err('no'), 0)).toBe(0);
	});

	it('map with the identity function changes nothing', () => {
		fc.assert(
			fc.property(fc.oneof(fc.integer().map(ok), fc.string().map(err)), (result) => {
				expect(map(result, (n) => n)).toEqual(result);
			})
		);
	});
});
