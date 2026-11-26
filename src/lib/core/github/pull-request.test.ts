import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	describePullRequestChange,
	describeInvalidPullRequestUrl,
	describePullRequest,
	parsePullRequestUrl,
	pullRequestIdentityParts,
	pullRequestNothingLeft,
	pullRequestUrl,
	samePullRequest,
	type PullRequestRef
} from './pull-request.ts';
import { pullRequestTitleOf } from './pull-request-title.tiny.ts';

function parsed(text: string): PullRequestRef {
	const result = parsePullRequestUrl(text);
	if (!result.ok) throw new Error(`Did not parse: ${text}`);
	return result.value;
}

describe('parsePullRequestUrl', () => {
	it('reads an address as a browser shows it, whatever comes after the number', () => {
		for (const url of [
			'https://github.com/acme/shop/pull/12',
			'https://github.com/acme/shop/pull/12/',
			'https://github.com/acme/shop/pull/12/files',
			'https://github.com/acme/shop/pull/12/commits/abc',
			'https://github.com/acme/shop/pull/12?diff=split',
			'https://github.com/acme/shop/pull/12#discussion_r1',
			'  https://github.com/acme/shop/pull/12  ',
			'http://www.github.com/acme/shop/pull/12'.replace('www.', ''),
			'https://github.com/acme/shop/pulls/12'
		]) {
			const ref = parsed(url);
			expect(ref.number, url).toBe(12);
			expect(ref.repository, url).toEqual({ host: 'github.com', owner: 'acme', name: 'shop' });
		}
	});

	it('says whether an address is of another site or of something else on GitHub', () => {
		const reason = (text: string): string | undefined => {
			const result = parsePullRequestUrl(text);
			return result.ok ? undefined : result.error.reason;
		};
		expect(reason('https://gitlab.com/acme/shop/-/merge_requests/3')).toBe('not-github');
		expect(reason('https://github.com/acme/shop/issues/12')).toBe('not-a-pull-request');
		expect(reason('https://github.com/acme/shop/pull/0')).toBe('not-a-pull-request');
		expect(reason('https://github.com/acme/shop/pull/x')).toBe('not-a-pull-request');
		expect(reason('https://github.com/acme/shop')).toBe('not-a-pull-request');
		expect(reason('not an address')).toBe('not-a-pull-request');
	});

	it('reads back the address it writes, for any owner, name and number', () => {
		const owner = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
		const name = fc
			.stringMatching(/^[A-Za-z0-9._-]{1,100}$/)
			.filter((n) => n !== '.' && n !== '..' && !n.toLowerCase().endsWith('.git'));
		fc.assert(
			fc.property(owner, name, fc.integer({ min: 1, max: 1_000_000 }), (o, n, number) => {
				const ref = parsed(`https://github.com/${o}/${n}/pull/${String(number)}`);
				expect(parsed(pullRequestUrl(ref))).toEqual(ref);
			})
		);
	});
});

describe('the identity of a pull request', () => {
	it('is the same whatever the case of its owner and name', () => {
		const a = parsed('https://github.com/Acme/Shop/pull/12');
		const b = parsed('https://github.com/acme/shop/pull/12/files');
		expect(pullRequestIdentityParts(a)).toEqual(['github.com', 'acme', 'shop', '12']);
		expect(samePullRequest(a, b)).toBe(true);
		expect(samePullRequest(a, parsed('https://github.com/acme/shop/pull/13'))).toBe(false);
	});
});

describe('the words for a pull request', () => {
	const ref = parsed('https://github.com/acme/shop/pull/12');

	it('names a Delve by its number and title', () => {
		expect(describePullRequest(ref, undefined)).toBe('Pull request #12');
		expect(describePullRequest(ref, pullRequestTitleOf('Add a discount rate'))).toBe(
			'Pull request #12: “Add a discount rate”'
		);
		expect(describePullRequest(ref, pullRequestTitleOf(''))).toBe('Pull request #12: “(no title)”');
	});

	it('writes out what cannot be seen and cuts a long title short', () => {
		expect(describePullRequest(ref, pullRequestTitleOf('a‮b'))).toBe(
			'Pull request #12: “a\\u202Eb”'
		);
		const long = describePullRequest(ref, pullRequestTitleOf('x'.repeat(200)));
		expect(long).toBe(`Pull request #12: “${'x'.repeat(79)}…”`);
	});

	it('says why a merged or closed one has nothing left', () => {
		expect(pullRequestNothingLeft(ref, 'merged').reason).toBe(
			'Nothing is left to review here: pull request #12 has been merged. What you were reading is still shown.'
		);
		expect(pullRequestNothingLeft(ref, 'closed').reason).toContain('closed without being merged');
		expect(pullRequestNothingLeft(ref, 'open').reason).toContain('no changes');
	});

	it('says whether commits were pushed or only its base changed', () => {
		expect(describePullRequestChange('pushed')).toContain(
			'New commits were pushed to it on GitHub.'
		);
		expect(describePullRequestChange('base')).toContain('Its base changed on GitHub');
	});

	it('says what to give instead of an address that is not a pull request', () => {
		const wrong = parsePullRequestUrl('https://gitlab.com/a/b/-/merge_requests/1');
		if (wrong.ok) throw new Error('parsed');
		expect(describeInvalidPullRequestUrl(wrong.error)).toContain('github.com only');
	});
});
