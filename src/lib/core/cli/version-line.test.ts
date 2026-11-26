import { describe, expect, it } from 'vitest';
import { parseCodeVersion } from '../code-version.tiny.ts';
import { parseCommitId } from '../commit-id.tiny.ts';
import { versionLine, versionOfLine } from './version-line.ts';

describe('the --version line', () => {
	it('names the commit after the version, and reads back as the version', () => {
		const version = parseCodeVersion('0.0.1-dev+3f2a1b9c0d4e');
		const commit = parseCommitId('a3f9c21' + '0'.repeat(33));
		if (!version.ok || !commit.ok) throw new Error('does not parse');
		const lines = [
			versionLine(version.value, undefined),
			versionLine(version.value, { commit: commit.value, committedAt: undefined, changes: false }),
			versionLine(version.value, { commit: commit.value, committedAt: undefined, changes: true })
		];
		expect(lines).toEqual([
			'diff-delver 0.0.1-dev+3f2a1b9c0d4e',
			'diff-delver 0.0.1-dev+3f2a1b9c0d4e (a3f9c21)',
			'diff-delver 0.0.1-dev+3f2a1b9c0d4e (a3f9c21 + changes)'
		]);
		for (const line of lines) expect(versionOfLine(`${line}\n`)).toBe(version.value);
		expect(versionOfLine('stand-in 1.0')).toBeUndefined();
	});
});
