import { describe, expect, it } from 'vitest';
import { parseGitHubAuthor } from './github-author.tiny.ts';
import { parseGitHubOwner } from './github-owner.tiny.ts';

const NAMES = ['octo', 'octo-org', 'a', 'A1-b2', 'x'.repeat(39)];
const NOT_NAMES = ['', '-octo', 'octo_org', 'octo.org', 'octo/org', 'x'.repeat(40), 'octo[bot]x'];

describe('a repository’s owner', () => {
	it('is what GitHub allows in an account’s name, and never a [bot]', () => {
		for (const name of NAMES) expect(parseGitHubOwner(name).ok, name).toBe(true);
		for (const name of [...NOT_NAMES, 'dependabot[bot]', 'octo[bot]']) {
			expect(parseGitHubOwner(name), name).toEqual({
				ok: false,
				error: { kind: 'InvalidGitHubOwner', value: name }
			});
		}
	});
});

describe('a pull request’s author', () => {
	it('is an account’s name, or one of GitHub’s own [bot] accounts', () => {
		for (const name of [...NAMES, 'dependabot[bot]', 'github-actions[bot]']) {
			expect(parseGitHubAuthor(name).ok, name).toBe(true);
		}
		for (const name of [...NOT_NAMES, '[bot]', 'octo[bot][bot]']) {
			expect(parseGitHubAuthor(name).ok, name).toBe(false);
		}
	});
});
