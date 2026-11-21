import { describe, expect, it } from 'vitest';
import { RangeSet } from '../range-set.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import {
	sameUnitSet,
	unitSetSize,
	withoutUnits,
	type FileUnitSet,
	type UnitSet
} from './unit-set.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

function set(entries: readonly (readonly [string, FileUnitSet])[]): UnitSet {
	return { files: new Map(entries.map(([p, f]) => [path(p), f])) };
}

describe('unit sets', () => {
	it('take one set out of another, leaving no entry for a file with nothing left', () => {
		const a = set([
			['a.ts', { old: RangeSet.of(1, 4), new: RangeSet.of(2), file: true }],
			['b.ts', { old: RangeSet.empty, new: RangeSet.of(5, 6), file: false }]
		]);
		const taken = set([
			['a.ts', { old: RangeSet.of(2, 3), new: RangeSet.empty, file: true }],
			['b.ts', { old: RangeSet.empty, new: RangeSet.of(5, 6), file: false }],
			['c.ts', { old: RangeSet.of(1), new: RangeSet.empty, file: false }]
		]);
		const left = withoutUnits(a, taken);
		expect(
			sameUnitSet(
				left,
				set([['a.ts', { old: RangeSet.fromNumbers([1, 4]), new: RangeSet.of(2), file: false }]])
			)
		).toBe(true);
		expect(unitSetSize(left)).toBe(3);
		expect(sameUnitSet(withoutUnits(a, { files: new Map() }), a)).toBe(true);
	});
});
