import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../absolute-path.tiny.ts';
import { parsePortNumber } from '../port-number.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import { describeStablePortTaken, preferredPortFor, STABLE_PORT } from './stable-port.ts';

function path(text: string): AbsolutePath {
	const parsed = parseAbsolutePath(text);
	if (!parsed.ok) throw new Error('not a path');
	return parsed.value;
}

describe('the port a daemon tries first', () => {
	const machine = path('/home/someone/.local/share/diff-delver');

	it('is 12321 for the machine’s default data folder', () => {
		expect(STABLE_PORT).toBe(12321);
		expect(preferredPortFor(machine, machine)).toBe(STABLE_PORT);
	});

	it('is any free one for another data folder, or when the machine has no default', () => {
		expect(preferredPortFor(path('/tmp/journey-1/data'), machine)).toBeUndefined();
		expect(preferredPortFor(machine, undefined)).toBeUndefined();
	});

	it('says which port it took instead, and why', () => {
		const taken = parsePortNumber(40123);
		if (!taken.ok) throw new Error('not a port');
		expect(describeStablePortTaken(STABLE_PORT, taken.value, { kind: 'in-use' })).toBe(
			'diff delver usually listens at http://127.0.0.1:12321, but something else was using that port, perhaps an earlier diff delver still stopping, so it is at http://127.0.0.1:40123. Pages opened before it started cannot find it there; run diff-delver to open them again. To have the usual address back, stop whatever uses port 12321, then run diff-delver stop and diff-delver.'
		);
	});

	it('says what the system said when it refused for another reason, without blaming another program', () => {
		const taken = parsePortNumber(40123);
		if (!taken.ok) throw new Error('not a port');
		expect(
			describeStablePortTaken(STABLE_PORT, taken.value, {
				kind: 'refused',
				detail: reviewerMessage('listen EACCES: permission denied 127.0.0.1:12321')
			})
		).toBe(
			'diff delver usually listens at http://127.0.0.1:12321, but the system would not let it listen there (listen EACCES: permission denied 127.0.0.1:12321), so it is at http://127.0.0.1:40123. Pages opened before it started cannot find it there; run diff-delver to open them again.'
		);
	});
});
