/**
 * How much work code did, counted rather than timed, so a test can hold it to a
 * bound on any machine, however slow or busy (docs/DEVELOPING.md, "Testing").
 *
 * It uses V8's precise block coverage: every time a function is called or one of
 * its blocks (a loop body, a branch) runs, V8 counts it. The work is the sum of
 * those counts for the code under `src/lib/core/`. It does not depend on the
 * machine or how busy it is, so a test can compare two input sizes and see
 * whether the work grows in proportion, which no timing can show reliably.
 *
 * V8 counts exactly only code compiled after counting started, so a test file
 * starts it with `startCountingWork()` before it imports the code it measures
 * (with `await import`), and counting stays on for that file. Even then a few
 * per cent of the count varies from run to run, so compare with a margin: linear
 * work over four times the input is about four times the count, quadratic work
 * sixteen. Core test files may not import dynamically, so these tests live in the
 * integration project.
 *
 * It counts only work done in core's own code. A built-in that core calls, such
 * as `includes`, `indexOf`, a spread or `sort`, counts as one step whatever the
 * size of what it works on, so a loop that calls `out.includes(x)` or builds
 * `out = [...out, x]` counts as linear although it is quadratic. Such a slowdown
 * shows only in the measured time.
 */
import { Session } from 'node:inspector/promises';
import { parseBlockCount, type BlockCount } from '../../src/lib/core/block-count.tiny.ts';

/** The directory whose code is counted. */
const COUNTED = '/src/lib/core/';

export interface WorkCounter {
	/** Runs `work` and gives its result with the number of blocks of core code it ran. */
	count<T>(work: () => T): Promise<{ readonly result: T; readonly blocks: BlockCount }>;
}

/** Starts counting. Call it before importing the code to be counted. */
export async function startCountingWork(): Promise<WorkCounter> {
	const session = new Session();
	session.connect();
	await session.post('Profiler.enable');
	await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
	return {
		async count(work) {
			// Taking the coverage resets the counts, so only `work` is counted.
			await session.post('Profiler.takePreciseCoverage');
			const result = work();
			const { result: scripts } = await session.post('Profiler.takePreciseCoverage');
			let blocks = 0;
			for (const script of scripts) {
				if (!script.url.includes(COUNTED)) continue;
				for (const fn of script.functions) {
					for (const range of fn.ranges) blocks += range.count;
				}
			}
			const counted = parseBlockCount(blocks);
			if (!counted.ok) throw new RangeError(`V8 gave a block count of ${String(blocks)}.`);
			return { result, blocks: counted.value };
		}
	};
}
