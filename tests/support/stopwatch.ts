/**
 * The real clock, for tests that measure how long the code under test takes.
 * Core code never reads the clock itself (README, "Layout"); a core test that
 * needs elapsed time takes it from here and passes it in.
 */
export function now(): number {
	return performance.now();
}
