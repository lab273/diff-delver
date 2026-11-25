import { describe, expect, it } from 'vitest';
import { parseRemoteName, type RemoteName } from '../history/remote-name.tiny.ts';
import { gitHubRepositoryOf, pickGitHubRemote, sameGitHubRepository } from './github-repository.ts';

function remote(name: string): RemoteName {
	const parsed = parseRemoteName(name);
	if (!parsed.ok) throw new Error(name);
	return parsed.value;
}

describe('gitHubRepositoryOf', () => {
	it('reads every way a clone of github.com is addressed', () => {
		for (const url of [
			'https://github.com/acme/shop.git',
			'https://github.com/acme/shop',
			'https://github.com/acme/shop/',
			'http://github.com/acme/shop.git',
			'https://user@github.com/acme/shop.git',
			'ssh://git@github.com/acme/shop.git',
			'ssh://git@github.com:22/acme/shop.git',
			'git@github.com:acme/shop.git',
			'git@github.com:acme/shop',
			'git://github.com/acme/shop.git',
			'https://GitHub.com/acme/shop.git'
		]) {
			expect(gitHubRepositoryOf(url), url).toEqual({
				host: 'github.com',
				owner: 'acme',
				name: 'shop'
			});
		}
	});

	it('keeps dots in a repository name, and only takes .git off the end', () => {
		expect(gitHubRepositoryOf('https://github.com/acme/shop.js.git')?.name).toBe('shop.js');
		expect(gitHubRepositoryOf('git@github.com:acme/acme.github.io.git')?.name).toBe(
			'acme.github.io'
		);
	});

	it('is nothing for another host, a local path or something that is not an address', () => {
		for (const url of [
			'https://gitlab.com/acme/shop.git',
			'git@gitlab.com:acme/shop.git',
			'/srv/git/shop.git',
			'file:///srv/git/shop.git',
			'../shop',
			'https://github.com/acme',
			'https://github.com/acme/shop/tree/main',
			'https://github.com/-acme/shop',
			'https://github.com/acme/shop?x=1',
			''
		]) {
			expect(gitHubRepositoryOf(url), url).toBeUndefined();
		}
	});
});

describe('pickGitHubRemote', () => {
	const shop = 'https://github.com/acme/shop.git';
	it('takes origin when it is on GitHub', () => {
		const picked = pickGitHubRemote([
			{ remote: remote('upstream'), url: 'https://github.com/other/shop.git' },
			{ remote: remote('origin'), url: shop }
		]);
		expect(picked?.remote).toBe('origin');
		expect(picked?.repository.owner).toBe('acme');
	});

	it('takes the first remote on GitHub by name when origin is not', () => {
		const picked = pickGitHubRemote([
			{ remote: remote('origin'), url: '/srv/git/shop.git' },
			{ remote: remote('zeta'), url: 'git@github.com:z/shop.git' },
			{ remote: remote('hub'), url: shop }
		]);
		expect(picked?.remote).toBe('hub');
	});

	it('is nothing when no remote is on GitHub', () => {
		expect(pickGitHubRemote([])).toBeUndefined();
		expect(
			pickGitHubRemote([{ remote: remote('origin'), url: 'https://gitlab.com/a/b.git' }])
		).toBeUndefined();
	});
});

describe('sameGitHubRepository', () => {
	it('compares owners and names in any case, as GitHub does', () => {
		const a = gitHubRepositoryOf('https://github.com/Acme/Shop.git');
		const b = gitHubRepositoryOf('git@github.com:acme/shop.git');
		const c = gitHubRepositoryOf('git@github.com:acme/till.git');
		if (a === undefined || b === undefined || c === undefined) throw new Error('unread');
		expect(sameGitHubRepository(a, b)).toBe(true);
		expect(sameGitHubRepository(a, c)).toBe(false);
	});
});
