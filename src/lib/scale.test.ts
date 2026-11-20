/**
 * The pure diff model at the size the design promises: 2,000 files and 200,000
 * changed lines should parse and compute coverage well under a second. The
 * second is guidance, which `pnpm verify` reports when it is exceeded; a real
 * blow-up fails on the hang timeout. In the integration project for its larger
 * per-test guidance; a quarter-size run sits in the core project
 * (`coverage.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { recordTime } from '../../tests/support/measured-time.ts';
import { now } from '../../tests/support/stopwatch.ts';
import { measurementName } from './core/measurement-name.tiny.ts';
import { millisecondsOf } from './core/milliseconds.tiny.ts';
import { runAtScale } from '../../tests/support/synthetic-diff.ts';

describe('the pure diff model at full scale', () => {
	it('reads, assigns and covers 2,000 files and 200,000 changed lines in under a second', ({
		task
	}) => {
		const { elapsed, unitCount, uncategorised } = runAtScale(2_000, now);
		expect(unitCount).toBe(200_000);
		expect(uncategorised).toBe(200_000 - 40_000 - 10);
		recordTime(
			task,
			measurementName('reading, assigning and covering'),
			millisecondsOf(elapsed),
			millisecondsOf(1_000)
		);
	});
});
