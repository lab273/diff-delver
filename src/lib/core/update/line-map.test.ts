import { describe, expect, it } from 'vitest';
import { tree, treeDiff } from '../../../../tests/support/tree-diffs.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { meaningful, NO_TREE_CHANGES, TreeLineMap } from './line-map.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const numbered = (count: number): readonly string[] =>
	Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`);

describe('where the lines of a later tree were', () => {
	it('gives every line of a file git does not list as itself', () => {
		const map = TreeLineMap.of(NO_TREE_CHANGES);
		expect(map.origin(path('a.ts'), 7)).toEqual({ path: 'a.ts', line: 7, weak: false });
		expect(map.earlierPath(path('a.ts'))).toBe('a.ts');
	});

	it('follows edits, insertions and deletions, giving changed lines no origin', () => {
		const before = numbered(20);
		// Line 3 removed, a line inserted after line 10, line 15 changed.
		const after = [
			...before.slice(0, 2),
			...before.slice(3, 10),
			'inserted',
			...before.slice(10, 14),
			'changed',
			...before.slice(15)
		];
		const map = TreeLineMap.of({
			kind: 'diff',
			files: treeDiff(tree({ 'a.ts': before }), tree({ 'a.ts': after }))
		});
		const origins = after.map((_, i) => map.origin(path('a.ts'), i + 1)?.line);
		expect(origins).toEqual([
			...[1, 2, 4, 5, 6, 7, 8, 9, 10],
			undefined,
			...[11, 12, 13, 14],
			undefined,
			...[16, 17, 18, 19, 20]
		]);
	});

	it('follows a rename, and follows nothing from a copy or a new file', () => {
		const lines = numbered(5);
		const map = TreeLineMap.of({
			kind: 'diff',
			files: treeDiff(
				tree({ 'a.ts': lines }),
				tree({ 'b.ts': lines, 'c.ts': lines, 'd.ts': lines }),
				{ renames: { 'a.ts': 'b.ts' }, copies: { 'a.ts': 'c.ts' } }
			)
		});
		expect(map.earlierPath(path('b.ts'))).toBe('a.ts');
		expect(map.origin(path('b.ts'), 3)).toEqual({ path: 'a.ts', line: 3, weak: false });
		expect(map.earlierPath(path('c.ts'))).toBeUndefined();
		expect(map.origin(path('c.ts'), 3)).toBeUndefined();
		expect(map.origin(path('d.ts'), 1)).toBeUndefined();
	});

	it('calls punctuation weak when only punctuation lies between it and an edit', () => {
		const before = ['a', 'start {', '  one', '}', '', 'b', 'c', 'd', 'e'];
		const after = ['a', 'start {', '  two', '}', '', 'b', 'c', 'd', 'e'];
		const map = TreeLineMap.of({
			kind: 'diff',
			files: treeDiff(tree({ 'a.ts': before }), tree({ 'a.ts': after }))
		});
		const weak = after.map((_, i) => map.origin(path('a.ts'), i + 1)?.weak);
		expect(weak).toEqual([false, false, undefined, true, true, false, false, false, false]);
	});

	it('follows nothing when the trees cannot be compared', () => {
		const map = TreeLineMap.of({ kind: 'unrelated' });
		expect(map.origin(path('a.ts'), 1)).toBeUndefined();
		expect(map.earlierPath(path('a.ts'))).toBeUndefined();
	});

	it('tells lines with a letter or digit from punctuation', () => {
		expect(['', '}', '  });', '// --', '\t'].map(meaningful)).toEqual([
			false,
			false,
			false,
			false,
			false
		]);
		expect(['x', '  return 1;', 'é', '日本', '0'].map(meaningful)).toEqual([
			true,
			true,
			true,
			true,
			true
		]);
	});
});
