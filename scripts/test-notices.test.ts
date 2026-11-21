import { describe, expect, it } from 'vitest';
import { vitestNotices } from './test-notices.ts';

describe('the notices tests recorded', () => {
	it('are read from the Vitest report, with the file that recorded each', () => {
		const report = {
			testResults: [
				{
					name: '/repo/tests/agent-trials/replay.test.ts',
					assertionResults: [
						{ meta: { notices: ['shop.claude.json was recorded with an older skill.'] } },
						{ meta: {} },
						{ meta: { notices: ['one', 2, 'two'] } }
					]
				},
				{ name: '/repo/src/a.test.ts', assertionResults: [{}] },
				'not a file'
			]
		};
		expect(vitestNotices(report, '/repo')).toEqual([
			{
				file: 'tests/agent-trials/replay.test.ts',
				text: 'shop.claude.json was recorded with an older skill.'
			},
			{ file: 'tests/agent-trials/replay.test.ts', text: 'one' },
			{ file: 'tests/agent-trials/replay.test.ts', text: 'two' }
		]);
		expect(vitestNotices(undefined, '/repo')).toEqual([]);
	});
});
