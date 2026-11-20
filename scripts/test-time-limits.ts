/**
 * How long a test should take, and how long it may take before it counts as hung,
 * for each type of test. The guidance is the README's ("Testing"); a test over it
 * is reported by `pnpm verify` as a warning, never a failure.
 *
 * The hang timeout is the only time limit that fails a test. It is there so that a
 * test that hangs fails instead of blocking the run, not to police speed, so it
 * sits well over an order of magnitude above the guidance: high enough that a
 * correct test on a slow or busy machine (CI runs several times slower than a
 * laptop, with dozens of jobs at once) never reaches it.
 *
 * vite.config.ts, playwright.config.ts and scripts/verify.ts all read this table.
 */
import { millisecondsOf, type Milliseconds } from '../src/lib/core/milliseconds.tiny.ts';

/** The three types of test (README, "Three layers"). */
export type TestLayer = 'core' | 'integration' | 'journey';

export interface TimeLimit {
	/** What one test of this type should take. Over it is a warning. */
	readonly guidance: Milliseconds;
	/** When a test of this type counts as hung and fails. */
	readonly hangTimeout: Milliseconds;
}

export const TIME_LIMITS: Readonly<Record<TestLayer, TimeLimit>> = {
	// 40 times the guidance.
	core: { guidance: millisecondsOf(250), hangTimeout: millisecondsOf(10_000) },
	// 20 times the guidance.
	integration: { guidance: millisecondsOf(3_000), hangTimeout: millisecondsOf(60_000) },
	// 15 times the guidance. A journey's own waits (`expect` polling) have their
	// limit set in playwright.config.ts for the same reason.
	journey: { guidance: millisecondsOf(20_000), hangTimeout: millisecondsOf(300_000) }
};

/** Where the core Vitest project's tests live (vite.config.ts); every other Vitest test is integration. */
export const CORE_TEST_DIRECTORY = 'src/lib/core/';
