import { describe, expect, it } from 'vitest';
import { parseGitHubBranchName } from './github-branch-name.tiny.ts';

describe('a GitHub branch name', () => {
	it('is any name git could have made a branch with', () => {
		for (const name of ['main', 'feature/discount-rate', 'v1.2', 'héllo', 'a@b', 'x.lockless']) {
			expect(parseGitHubBranchName(name).ok, name).toBe(true);
		}
	});

	it('is refused where git would refuse it', () => {
		for (const name of [
			'',
			'@',
			'-main',
			'a b',
			'tab\there',
			'a:b',
			'a*',
			'a?',
			'a[b',
			'a\\b',
			'a^',
			'a~1',
			'a..b',
			'a@{1}',
			'/a',
			'a/',
			'a//b',
			'.hidden',
			'a/.b',
			'a.lock',
			'a.lock/b',
			'a.',
			'\ud800',
			'x'.repeat(256)
		]) {
			expect(parseGitHubBranchName(name).ok, name).toBe(false);
		}
	});
});
