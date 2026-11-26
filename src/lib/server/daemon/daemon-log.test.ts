import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { daemonLog } from './daemon-log.ts';

describe('the daemon log', () => {
	it('writes each line of an entry with the time by the daemon’s clock', () => {
		const start = parseTimestamp(Date.UTC(2026, 10, 26, 21, 49, 22));
		if (!start.ok) throw new Error('not a time');
		const written: string[] = [];
		const log = daemonLog(settableClock(start.value), (text) => written.push(text));
		const error = new Error('broke');
		error.stack = 'Error: broke\n    at somewhere';
		log('diff delver hit an error it did not expect:', error);
		expect(written).toEqual([
			'2026-11-26T21:49:22Z diff delver hit an error it did not expect: Error: broke\n2026-11-26T21:49:22Z     at somewhere\n'
		]);
	});
});
