/**
 * Something a test found that a person should know but that must not fail the
 * run, such as a recording made with an older skill: recorded here, and listed
 * by `pnpm verify` beside its warnings about time (scripts/test-notices.ts).
 *
 * The notices travel in the test's `meta`, which Vitest's JSON report carries
 * to `scripts/verify.ts`, as measured times do (measured-time.ts).
 */
import type { TaskMeta } from 'vitest';

declare module 'vitest' {
	interface TaskMeta {
		/** Read by scripts/test-notices.ts, from Vitest's JSON report. */
		notices?: string[];
	}
}

/** The part of a running test that holds its metadata: `({ task }) => …` in a test. */
export interface NoticedTask {
	readonly meta: TaskMeta;
}

/** Records a notice for `pnpm verify` to list: what was found, and what to do about it. */
export function recordNotice(task: NoticedTask, notice: string): void {
	task.meta.notices = [...(task.meta.notices ?? []), notice];
}
