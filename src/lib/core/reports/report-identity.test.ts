import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../absolute-path.tiny.ts';
import { parseReportIdentity } from '../report-identity.tiny.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '../sources/git-source-spec.ts';
import { parseStoreId, type StoreId } from '../store-id.tiny.ts';
import { dependsOnWorktree, gitReportIdentity } from './report-identity.ts';
import { parseRevision } from '../revision.tiny.ts';

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
	if (!result.ok) throw new Error('expected a value');
	return result.value;
}

const store: StoreId = value(parseStoreId('repo-1234'));
const otherStore: StoreId = value(parseStoreId('other-5678'));
const main: AbsolutePath = value(parseAbsolutePath('/work/repo'));
const linked: AbsolutePath = value(parseAbsolutePath('/work/repo-feature'));
const spec = (text: string): GitSourceSpec => value(parseGitSourceSpec(text));

const identity = (text: string, worktree = main, at = store) =>
	gitReportIdentity({ store: at, spec: spec(text), worktree });

describe('the identity of a local git source', () => {
	it('ties the working tree and the index to their worktree', () => {
		expect(identity('working-tree')).toBe(identity('uncommitted'));
		expect(identity('working-tree')).not.toBe(identity('working-tree', linked));
		expect(identity('staged')).not.toBe(identity('staged', linked));
		expect(identity('staged')).not.toBe(identity('working-tree'));
	});

	it('names a range by its two ends as written, in any worktree', () => {
		expect(identity('main...feature')).toBe(identity('main...feature', linked));
		expect(identity('main...feature')).toBe(identity('main..feature'));
		expect(identity('main...feature')).not.toBe(identity('main...refs/heads/feature'));
		expect(identity('abc1234')).toBe(identity('abc1234', linked));
	});

	it('ties a commit or range that names HEAD or @ to the worktree', () => {
		expect(identity('HEAD')).not.toBe(identity('HEAD', linked));
		expect(identity('main...')).not.toBe(identity('main...', linked));
		expect(identity('@~2')).not.toBe(identity('@~2', linked));
		expect(identity('main@{u}...main')).not.toBe(identity('main@{u}...main', linked));
	});

	it('differs between repositories', () => {
		expect(identity('working-tree')).not.toBe(identity('working-tree', main, otherStore));
		expect(identity('main...feature')).not.toBe(identity('main...feature', main, otherStore));
	});

	it('reads back as itself, and nothing else does', () => {
		const id = identity('main...feature');
		expect(parseReportIdentity(id)).toEqual({ ok: true, value: id });
		for (const bad of ['', '[]', '["git"]', '["svn","a"]', '[ "git", "a" ]', '["git",1]', 'nope']) {
			expect(parseReportIdentity(bad).ok).toBe(false);
		}
	});

	it.each([
		['HEAD', true],
		['HEAD~2', true],
		['ORIG_HEAD', true],
		['@', true],
		['@{-1}', true],
		['main@{upstream}', true],
		['main', false],
		['refs/heads/feature', false],
		['v1.2^', false]
	])('reads %s as depending on the worktree: %s', (text, depends) => {
		expect(dependsOnWorktree(value(parseRevision(text)))).toBe(depends);
	});
});
