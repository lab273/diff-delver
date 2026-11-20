/**
 * Times measured inside a test, held to guidance rather than to a hard limit.
 *
 * A size test that times the code under test must not fail because the machine
 * is slow or busy (README, "Testing"). It records what it measured here, against
 * the time it should take, and `pnpm verify` lists every measurement over its
 * guidance as a warning, beside the tests over theirs. A time cannot show a
 * slowdown on its own, so the work is bounded without the clock as well: by the
 * glob matcher's step count, or by counting it at two sizes
 * (tests/support/work-count.ts, src/lib/work-growth.test.ts).
 *
 * The records travel in the test's `meta`, which Vitest's JSON report carries to
 * `scripts/verify.ts`.
 */
import type { TaskMeta } from 'vitest';
import { millisecondsOf, type Milliseconds } from '../../src/lib/core/milliseconds.tiny.ts';
import { now } from './stopwatch.ts';

/** One measurement: what was timed, how long it took, and how long it should take. */
export interface MeasuredTime {
	readonly what: string;
	readonly ms: Milliseconds;
	readonly guidance: Milliseconds;
}

declare module 'vitest' {
	interface TaskMeta {
		/** Read by scripts/test-timings.ts, from Vitest's JSON report. */
		measuredTimes?: MeasuredTime[];
	}
}

/** The part of a running test that holds its metadata: `({ task }) => …` in a test. */
export interface MeasuredTask {
	readonly meta: TaskMeta;
}

/** Records a time the test measured itself. */
export function recordTime(
	task: MeasuredTask,
	what: string,
	ms: number,
	guidance: Milliseconds
): void {
	const record: MeasuredTime = { what, ms: millisecondsOf(ms), guidance };
	task.meta.measuredTimes = [...(task.meta.measuredTimes ?? []), record];
}

/** Runs `work`, records how long it took against its guidance, and returns its result. */
export function timed<T>(
	task: MeasuredTask,
	what: string,
	guidance: Milliseconds,
	work: () => T
): T {
	const started = now();
	const result = work();
	recordTime(task, what, now() - started, guidance);
	return result;
}
