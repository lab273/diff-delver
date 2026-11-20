import { describe, expect, it } from 'vitest';
import {
	isAtLeast,
	MINIMUM_GIT_VERSION,
	parseGitVersion,
	type GitVersion
} from './git-version.tiny.ts';

function version(text: string): GitVersion {
	const parsed = parseGitVersion(text);
	if (!parsed.ok) throw new Error(`not a version: ${text}`);
	return parsed.value;
}

describe('git versions', () => {
	it("reads what git --version prints, with a platform's suffix", () => {
		expect(version('git version 2.53.0\n')).toBe('2.53.0');
		expect(version('git version 2.39.3 (Apple Git-146)')).toBe('2.39.3');
		expect(version('git version 2.45.1.windows.1')).toBe('2.45.1');
		expect(version('git version 2.46')).toBe('2.46.0');
		expect(version('2.45.0')).toBe('2.45.0');
		expect(parseGitVersion('hub version 2.14.2').ok).toBe(false);
		expect(parseGitVersion('').ok).toBe(false);
	});

	it('compares releases by their numbers, not as text', () => {
		expect(isAtLeast(version('2.45.0'), MINIMUM_GIT_VERSION)).toBe(true);
		expect(isAtLeast(version('2.100.0'), MINIMUM_GIT_VERSION)).toBe(true);
		expect(isAtLeast(version('3.0.0'), MINIMUM_GIT_VERSION)).toBe(true);
		expect(isAtLeast(version('2.44.9'), MINIMUM_GIT_VERSION)).toBe(false);
		expect(isAtLeast(version('2.5.0'), MINIMUM_GIT_VERSION)).toBe(false);
		expect(isAtLeast(version('1.99.99'), MINIMUM_GIT_VERSION)).toBe(false);
	});
});
