/**
 * The pure diff model at the size the design promises: 2,000 files and 200,000
 * changed lines must parse and compute coverage well under a second. In the
 * integration project for its larger per-test budget; a quarter-size run sits in
 * the core project (`coverage.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { now } from '../../tests/support/stopwatch.ts';
import { runAtScale } from '../../tests/support/synthetic-diff.ts';

describe('the pure diff model at full scale', () => {
	it('reads, assigns and covers 2,000 files and 200,000 changed lines in under a second', () => {
		const { elapsed, unitCount, uncategorised } = runAtScale(2_000, now);
		expect(unitCount).toBe(200_000);
		expect(uncategorised).toBe(200_000 - 40_000 - 10);
		expect(elapsed).toBeLessThan(1_000);
	});
});
