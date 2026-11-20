/**
 * The journey run's own waits are hang timeouts, not timing limits
 * (scripts/test-time-limits.ts): Playwright's defaults would fail a correct run
 * on a slow or busy machine.
 */
import { describe, expect, it } from 'vitest';
import config from '../playwright.config.ts';
import { TIME_LIMITS, WAIT_HANG_TIMEOUTS } from './test-time-limits.ts';

describe('playwright.config.ts', () => {
	it('takes every timeout from the table of hang timeouts', () => {
		expect(config.timeout).toBe(TIME_LIMITS.journey.hangTimeout);
		expect(config.expect?.timeout).toBe(WAIT_HANG_TIMEOUTS.expectPolling);
		const servers = [config.webServer ?? []].flat();
		expect(servers.map((server) => server.timeout)).toEqual([WAIT_HANG_TIMEOUTS.serverStart]);
	});

	it('gives the built app minutes to start, not Playwright’s default of one', () => {
		expect(WAIT_HANG_TIMEOUTS.serverStart).toBeGreaterThanOrEqual(5 * 60_000);
	});
});
