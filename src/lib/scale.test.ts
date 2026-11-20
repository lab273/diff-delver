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
import { updateAtScale } from '../../tests/support/update-scale.ts';
import { carryOver } from './core/update/carry-over.ts';

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

	it('carries an update of 2,000 files and 200,000 changed lines over in under a second', ({
		task
	}) => {
		const input = updateAtScale(2_000);
		const started = now();
		const carried = carryOver(input);
		const elapsed = now() - started;
		expect(input.diff.unitCount).toBe(202_000);
		expect(carried.summary.newToReview).toBe(2_000);
		expect(carried.summary.reviewedKept).toBe(100_000);
		recordTime(
			task,
			measurementName('carrying an update over'),
			millisecondsOf(elapsed),
			millisecondsOf(1_000)
		);
	});

	it('carries an update of one file with 50,000 changed lines over in under half a second', ({
		task
	}) => {
		const input = updateAtScale(1, 1_000);
		const started = now();
		const carried = carryOver(input);
		const elapsed = now() - started;
		expect(input.diff.unitCount).toBe(50_001);
		expect(carried.summary.reviewedKept).toBe(50_000);
		recordTime(
			task,
			measurementName('carrying a large file over'),
			millisecondsOf(elapsed),
			millisecondsOf(500)
		);
	});
});
