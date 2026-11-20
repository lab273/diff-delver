/**
 * The pure diff model's work grows in proportion to its input, counted rather
 * than timed (tests/support/work-count.ts), so a quadratic slowdown fails here on
 * any machine. The core tests time the same work at one size and report it
 * against guidance; a quadratic version of it at that size is a warning, nowhere
 * near the hang timeout, so on its own the timing cannot catch it.
 *
 * Each test runs the work at a quarter of the size and at the full size, and
 * holds the ratio of the counts under SIX: linear work gives about 4, n log n a
 * little more, quadratic 16.
 */
import { describe, expect, it } from 'vitest';
import { startCountingWork } from '../../tests/support/work-count.ts';

// Counting must start before the code it counts is loaded.
const counter = await startCountingWork();
const { runAtScale, syntheticDiff } = await import('../../tests/support/synthetic-diff.ts');
const { assign, describeRejection } = await import('./core/diff/assign.ts');
const { initialState } = await import('./core/diff/state.ts');
const { updateAtScale } = await import('../../tests/support/update-scale.ts');
const { carryOver } = await import('./core/update/carry-over.ts');

/** Most the count may grow when the input grows four times. */
const SIX = 6;

/** Refuses an assignment of `size` line ranges that hold no changed line, as the agent would see it. */
function refuseEmptyRanges(size: number): () => string {
	const diff = syntheticDiff([
		{
			path: 'huge.ts',
			change: 'modified',
			hunks: Array.from({ length: size }, () => ({ gap: 1, lines: [' ', '+', ' '] as const }))
		}
	]);
	const state = initialState(diff);
	const changed = diff.files[0]?.changed.new;
	const unchanged: string[] = [];
	for (let n = 1; unchanged.length < size; n += 1) {
		if (changed?.has(n) !== true) unchanged.push(`+${String(n)}`);
	}
	const request = { file: 'huge.ts', lines: unchanged.join(','), section: 'alpha' };
	return () => {
		const rejection = assign(diff, state, [request]).rejected[0]?.rejection;
		if (rejection === undefined) throw new Error('The ranges were not refused.');
		return describeRejection(rejection);
	};
}

describe('the work the diff model does grows in proportion to its input', () => {
	it('refusing 5,000 empty line ranges is about four times refusing 1,250', async () => {
		const small = await counter.count(refuseEmptyRanges(1_250));
		const large = await counter.count(refuseEmptyRanges(5_000));
		expect(large.result).toContain('and 4990 more hold no changed line');
		expect(large.blocks / small.blocks).toBeLessThan(SIX);
	});

	it('reading, assigning and covering 2,000 files is about four times 500', async () => {
		const small = await counter.count(() => runAtScale(500, () => 0));
		const large = await counter.count(() => runAtScale(2_000, () => 0));
		expect(large.result.unitCount).toBe(200_000);
		expect(large.blocks / small.blocks).toBeLessThan(SIX);
	});

	it('carrying 2,000 files over is about four times 500', async () => {
		const smallInput = updateAtScale(500);
		const largeInput = updateAtScale(2_000);
		const small = await counter.count(() => carryOver(smallInput).summary);
		const large = await counter.count(() => carryOver(largeInput).summary);
		expect(large.result.reviewedKept).toBe(100_000);
		expect(large.blocks / small.blocks).toBeLessThan(SIX);
	});

	it('carrying one file of 40,000 changed lines over is about four times 10,000', async () => {
		const smallInput = updateAtScale(1, 200);
		const largeInput = updateAtScale(1, 800);
		const small = await counter.count(() => carryOver(smallInput).summary);
		const large = await counter.count(() => carryOver(largeInput).summary);
		expect(large.result.reviewedKept).toBe(40_000);
		expect(large.blocks / small.blocks).toBeLessThan(SIX);
	});
});
