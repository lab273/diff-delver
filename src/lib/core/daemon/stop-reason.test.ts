import { describe, expect, it } from 'vitest';
import { parseCodeVersion } from '../code-version.tiny.ts';
import { describeStop } from './stop-reason.ts';

describe('why a daemon stops', () => {
	it('names what stopped it, and the version that replaced it', () => {
		const version = parseCodeVersion('0.2.0+1a2b3c4d5e6f');
		if (!version.ok) throw new Error('not a version');
		expect(describeStop({ kind: 'replaced', by: version.value })).toBe(
			'diff delver is stopping: diff delver 0.2.0+1a2b3c4d5e6f is replacing it.'
		);
		expect(describeStop({ kind: 'command' })).toBe(
			'diff delver is stopping: diff-delver stop asked it to.'
		);
		expect(describeStop({ kind: 'signal', signal: 'SIGTERM' })).toBe(
			'diff delver is stopping: it was sent SIGTERM.'
		);
	});
});
