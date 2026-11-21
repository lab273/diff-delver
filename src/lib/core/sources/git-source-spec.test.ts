import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fileCountOf } from '../file-count.tiny.ts';
import {
	describeGitSource,
	describeGitSourceWithSize,
	describeInvalidSourceSpec,
	formatGitSourceSpec,
	parseGitSourceSpec,
	type GitSourceSpec
} from './git-source-spec.ts';

function parsed(text: string): GitSourceSpec {
	const result = parseGitSourceSpec(text);
	if (!result.ok) throw new Error(`Did not parse: ${text}`);
	return result.value;
}

describe('parseGitSourceSpec', () => {
	it('reads the words for the working tree and the index, in any case', () => {
		for (const word of ['working-tree', 'worktree', 'Uncommitted', ' WORKING-TREE ']) {
			expect(parsed(word)).toEqual({ kind: 'working-tree' });
		}
		for (const word of ['staged', '--staged', 'cached', '--cached', 'Staged']) {
			expect(parsed(word)).toEqual({ kind: 'staged' });
		}
	});

	it('reads a revision that is also a property name of every object as a commit', () => {
		expect(parsed('constructor')).toEqual({ kind: 'commit', revision: 'constructor' });
		expect(parsed('__proto__')).toEqual({ kind: 'commit', revision: '__proto__' });
	});

	it('reads one revision as a commit', () => {
		expect(parsed('HEAD')).toEqual({ kind: 'commit', revision: 'HEAD' });
		expect(parsed('abc1234')).toEqual({ kind: 'commit', revision: 'abc1234' });
		expect(parsed('v1.2^')).toEqual({ kind: 'commit', revision: 'v1.2^' });
		expect(parsed('HEAD@{2 days ago}')).toEqual({ kind: 'commit', revision: 'HEAD@{2 days ago}' });
	});

	it('reads two and three dots alike, as a range from the merge base, with HEAD for an empty end', () => {
		expect(parsed('main...feature-x')).toEqual({ kind: 'range', from: 'main', to: 'feature-x' });
		expect(parsed('main..feature-x')).toEqual({ kind: 'range', from: 'main', to: 'feature-x' });
		expect(parsed('origin/main...')).toEqual({ kind: 'range', from: 'origin/main', to: 'HEAD' });
		expect(parsed('...feature')).toEqual({ kind: 'range', from: 'HEAD', to: 'feature' });
	});

	it('refuses what git would misread, with a message that says what to type', () => {
		for (const text of ['', '   ', '-n', 'a...b...c', 'main... feature', 'a\tb', '..']) {
			const result = parseGitSourceSpec(text);
			expect(result.ok, text).toBe(text === '..');
			if (!result.ok) expect(describeInvalidSourceSpec(result.error).length).toBeGreaterThan(30);
		}
		// `..` alone is HEAD against HEAD, as in git: an empty range, not an error.
		expect(parsed('..')).toEqual({ kind: 'range', from: 'HEAD', to: 'HEAD' });
	});

	it('reads every written form back to the same source', () => {
		const revision = fc
			.stringMatching(/^[A-Za-z0-9_/^~@{}.-]{1,12}$/)
			.filter((text) => parseGitSourceSpec(text).ok && !text.includes('.'));
		const spec = fc.oneof(
			fc.constant<GitSourceSpec>({ kind: 'working-tree' }),
			fc.constant<GitSourceSpec>({ kind: 'staged' }),
			revision.map((text) => parsed(text)),
			fc.tuple(revision, revision).map(([a, b]) => parsed(`${a}...${b}`))
		);
		fc.assert(
			fc.property(spec, (s) => {
				expect(parsed(formatGitSourceSpec(s))).toEqual(s);
			})
		);
	});
});

describe('describeGitSource', () => {
	it('says what each source is in plain words', () => {
		expect(describeGitSource(parsed('working-tree'))).toBe('Uncommitted changes');
		expect(describeGitSource(parsed('staged'))).toBe('Staged changes');
		expect(describeGitSource(parsed('HEAD'))).toBe('The last commit');
		expect(describeGitSource(parsed('0123456789abcdef0123456789abcdef01234567'))).toBe(
			'Commit 0123456'
		);
		expect(describeGitSource(parsed('refs/remotes/origin/main...refs/heads/feature-x'))).toBe(
			'feature-x compared with origin/main'
		);
		expect(describeGitSource(parsed('main...'))).toBe('The checked-out commit compared with main');
	});

	it('never names a local branch called HEAD, or staged, as if it were something else', () => {
		expect(describeGitSource(parsed('refs/remotes/origin/main...refs/heads/HEAD'))).toBe(
			'The local branch HEAD compared with origin/main'
		);
		expect(describeGitSource(parsed('refs/heads/staged...refs/heads/feature-x'))).toBe(
			'feature-x compared with the local branch staged'
		);
		expect(describeGitSource(parsed('refs/heads/HEAD'))).toBe(
			'The last commit of the local branch HEAD'
		);
		// A remote's HEAD is named with its remote, so it cannot be taken for the checked-out commit.
		expect(describeGitSource(parsed('refs/remotes/origin/HEAD...refs/heads/x'))).toBe(
			'x compared with origin/HEAD'
		);
	});

	it('says what two commit ids compare, from a commit or from nothing', () => {
		const to = 'abcdef0123456789abcdef0123456789abcdef01';
		expect(describeGitSource(parsed(`0123456789abcdef0123456789abcdef01234567...${to}`))).toBe(
			'Commit abcdef0 compared with commit 0123456'
		);
		expect(describeGitSource(parsed(`4b825dc642cb6eb9a060e54bf8d69288fbee4904...${to}`))).toBe(
			'Every commit up to abcdef0'
		);
	});

	it('gives the size for the start page’s choice', () => {
		expect(describeGitSourceWithSize(parsed('working-tree'), fileCountOf(12))).toBe(
			'Uncommitted changes (12 files)'
		);
		expect(describeGitSourceWithSize(parsed('main...feature-x'), fileCountOf(1))).toBe(
			'feature-x compared with main (1 file)'
		);
		expect(describeGitSourceWithSize(parsed('staged'), fileCountOf(0))).toBe(
			'Staged changes (no files)'
		);
		expect(describeGitSourceWithSize(parsed('main...feature-x'), undefined)).toBe(
			'feature-x compared with main'
		);
	});
});
