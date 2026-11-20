import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { now } from '../../../../tests/support/stopwatch.ts';
import {
	arbitraryDiff,
	GLOBS,
	MISSING_PATHS,
	SECTIONS,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { parseSectionId, type SectionId } from '../section-id.tiny.ts';
import type { Side } from '../side.tiny.ts';
import {
	assign,
	describeNothingTaken,
	describeRangesTakingNothing,
	describeRejection,
	type AssignRejection,
	type AssignRequest
} from './assign.ts';
import { autoIgnore } from './auto-ignore.ts';
import type { Diff, DiffFile } from './diff.ts';
import { initialState, sameAssignment, type Assignment, type AssignmentState } from './state.ts';

// A small diff: one modified file with two hunks, one added file, one binary file.
//
// src/app.ts h1: old 1 ctx, -2, -3, +2, +3, +4, ctx; h2 after a gap: ctx, +11, ctx
const diff = syntheticDiff([
	{ path: 'assets/logo.png', change: 'binary' },
	{
		path: 'src/app.test.ts',
		change: 'added',
		lines: 4
	},
	{
		path: 'src/app.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '-', '-', '+', '+', '+', ' '] },
			{ gap: 4, lines: [' ', '+', ' '] }
		]
	}
]);
const state = initialState(diff);

function section(id: string): SectionId {
	const parsed = parseSectionId(id);
	if (!parsed.ok) throw new Error(`bad section ${id}`);
	return parsed.value;
}

/** The assignment of one unit: a line on a side, or the file-level unit. */
function at(s: AssignmentState, path: string, side?: Side, line?: number): Assignment | undefined {
	const file = [...s.files.entries()].find(([p]) => p === path)?.[1];
	if (file === undefined) return undefined;
	if (file.kind === 'file') return file.assignment;
	if (side === undefined || line === undefined) return undefined;
	return (side === 'old' ? file.old : file.new).get(line);
}

const bucketOf = (s: AssignmentState, path: string, side?: Side, line?: number): string => {
	const bucket = at(s, path, side, line)?.bucket;
	switch (bucket?.kind) {
		case 'section':
			return bucket.section;
		case 'ignored':
			return 'ignored';
		case 'uncategorised':
			return 'uncategorised';
		case undefined:
			return 'missing';
	}
};

describe('initialState', () => {
	it('puts every unit in Uncategorised and guesses roles from paths', () => {
		expect(diff.unitCount).toBe(1 + 4 + 6);
		expect(bucketOf(state, 'assets/logo.png')).toBe('uncategorised');
		expect(at(state, 'src/app.test.ts', 'new', 1)?.role).toBe('test');
		expect(at(state, 'src/app.ts', 'old', 2)?.role).toBe('code');
	});
});

describe('assign', () => {
	it('assigns line ranges in the agent-facing form', () => {
		const outcome = assign(diff, state, [
			{ file: 'src/app.ts', lines: '-2..-3,+2', section: 'alpha' }
		]);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.accepted).toEqual([{ index: 0, units: 3 }]);
		expect(bucketOf(outcome.state, 'src/app.ts', 'old', 2)).toBe('alpha');
		expect(bucketOf(outcome.state, 'src/app.ts', 'new', 2)).toBe('alpha');
		expect(bucketOf(outcome.state, 'src/app.ts', 'new', 3)).toBe('uncategorised');
		expect(outcome.uncategorised).toBe(diff.unitCount - 3);
	});

	it('assigns hunks by id', () => {
		const outcome = assign(diff, state, [{ file: 'src/app.ts', hunks: ['h2'], section: 'beta' }]);
		expect(outcome.accepted).toEqual([{ index: 0, units: 1 }]);
		expect(bucketOf(outcome.state, 'src/app.ts', 'new', 11)).toBe('beta');
	});

	it('lets a whole file take only what is still uncategorised', () => {
		const first = assign(diff, state, [{ file: 'src/app.ts', lines: '+3', section: 'alpha' }]);
		const second = assign(diff, first.state, [{ file: 'src/app.ts', section: 'beta' }]);
		expect(second.accepted).toEqual([{ index: 0, units: 5 }]);
		expect(bucketOf(second.state, 'src/app.ts', 'new', 3)).toBe('alpha');
		expect(bucketOf(second.state, 'src/app.ts', 'new', 4)).toBe('beta');
	});

	it('takes the changed lines inside a range that also spans unchanged lines', () => {
		const outcome = assign(diff, state, [
			{ file: 'src/app.ts', lines: '+1..+3', section: 'alpha' },
			{ file: 'src/app.ts', lines: '-1..-9,+4..+20', section: 'beta' }
		]);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.accepted).toEqual([
			{ index: 0, units: 2 },
			{ index: 1, units: 4 }
		]);
		expect(bucketOf(outcome.state, 'src/app.ts', 'new', 3)).toBe('alpha');
		expect(bucketOf(outcome.state, 'src/app.ts', 'new', 11)).toBe('beta');
		expect(outcome.uncategorised).toBe(diff.unitCount - 6);
	});

	it('says why a whole file or glob took nothing, and how to move what is assigned', () => {
		const outcome = assign(diff, state, [
			{ file: 'src/app.ts', section: 'alpha' },
			{ file: 'src/app.ts', section: 'beta' },
			{ glob: 'src/*', section: 'beta' }
		]);
		expect(outcome.rejected).toEqual([]);
		const [, repeated, glob] = outcome.accepted;
		expect(repeated?.units).toBe(0);
		expect(repeated?.nothingTaken).toEqual({
			target: { kind: 'file', path: 'src/app.ts' },
			sortedInto: [{ kind: 'section', section: 'alpha' }],
			takenEarlierInCall: true
		});
		const message = repeated?.nothingTaken && describeNothingTaken(repeated.nothingTaken);
		expect(message).toContain('took nothing');
		expect(message).toContain('section "alpha"');
		expect(message).toContain('an earlier item in this call');
		expect(message).toMatch(/"lines" or "hunks"/);
		expect(glob?.units).toBe(4);
		expect(glob?.nothingTaken).toBeUndefined();
	});

	it('says when a whole file took nothing because a rule had already ignored it', () => {
		const lock = syntheticDiff([{ path: 'package-lock.json', change: 'added', lines: 3 }]);
		const ignored = autoIgnore(lock, initialState(lock)).state;
		const [taken] = assign(lock, ignored, [
			{ file: 'package-lock.json', section: 'alpha' }
		]).accepted;
		expect(taken?.nothingTaken?.takenEarlierInCall).toBe(false);
		expect(taken?.nothingTaken && describeNothingTaken(taken.nothingTaken)).toContain(
			'Ignored (Lockfile)'
		);
	});

	it('lets line ranges move lines that are already assigned', () => {
		const first = assign(diff, state, [{ file: 'src/app.ts', section: 'alpha' }]);
		const second = assign(diff, first.state, [
			{ file: 'src/app.ts', lines: '+3', section: 'beta' }
		]);
		expect(second.accepted).toEqual([{ index: 0, units: 1 }]);
		expect(bucketOf(second.state, 'src/app.ts', 'new', 3)).toBe('beta');
	});

	it('assigns files matched by a glob, and file-level units', () => {
		const outcome = assign(diff, state, [
			{ glob: '*.png', section: 'ignored', reason: 'Regenerated artwork' }
		]);
		expect(outcome.accepted).toEqual([{ index: 0, units: 1 }]);
		const logo = at(outcome.state, 'assets/logo.png');
		expect(logo?.bucket).toEqual({
			kind: 'ignored',
			by: { kind: 'agent', reason: 'Regenerated artwork' }
		});
	});

	it('sets a role on its own, on every unit it targets', () => {
		const first = assign(diff, state, [{ file: 'src/app.ts', lines: '+2', section: 'alpha' }]);
		const outcome = assign(diff, first.state, [{ file: 'src/app.ts', role: 'test' }]);
		expect(outcome.accepted).toEqual([{ index: 0, units: 6 }]);
		expect(at(outcome.state, 'src/app.ts', 'new', 2)).toEqual({
			bucket: { kind: 'section', section: 'alpha' },
			role: 'test'
		});
	});

	it('keeps valid items when a glob in the same call is malformed', () => {
		const outcome = assign(diff, state, [
			{ file: 'src/app.ts', lines: '+2', section: 'alpha' },
			{ glob: '[z-a]', section: 'alpha' },
			{ glob: '[\\q]', section: 'alpha' },
			{ file: 'src/app.ts', lines: '+3', section: 'beta' }
		]);
		expect(outcome.accepted.map((a) => a.index)).toEqual([0, 3]);
		expect(outcome.rejected.map((r) => [r.index, r.rejection.kind])).toEqual([
			[1, 'MalformedGlob'],
			[2, 'GlobMatchesNothing']
		]);
	});

	it('matches a pathological glob against many long paths quickly, and refuses an overlong one', () => {
		const long = syntheticDiff(
			Array.from({ length: 200 }, (_, i) => ({
				path: `${'a/'.repeat(100)}${'a'.repeat(200)}${String(i)}`,
				change: 'added' as const,
				lines: 1
			}))
		);
		const started = now();
		const outcome = assign(long, initialState(long), [
			{ glob: `${'*a'.repeat(12)}*b`, section: 'alpha' },
			{ glob: `${'**/'.repeat(30)}z`, section: 'alpha' },
			{ glob: 'a'.repeat(300), section: 'alpha' }
		]);
		expect(now() - started).toBeLessThan(250);
		expect(outcome.rejected.map((r) => [r.index, r.rejection.kind])).toEqual([
			[0, 'GlobMatchesNothing'],
			[1, 'GlobMatchesNothing'],
			[2, 'MalformedGlob']
		]);
		const overlong = outcome.rejected[2]?.rejection;
		if (overlong === undefined) throw new Error('no rejection');
		expect(describeRejection(overlong)).toContain('longer than 256 characters');
	});

	it('accepts a path that is not UTF-8 in its escaped form, plain or JSON-quoted', () => {
		const odd = syntheticDiff([
			{ path: 'caf\uDCE8.txt', change: 'added', lines: 1 },
			{ path: 'caf\uDCE9.txt', change: 'added', lines: 2 }
		]);
		const outcome = assign(odd, initialState(odd), [
			{ file: 'caf\\xE9.txt', section: 'alpha' },
			{ file: '"caf\\\\xE8.txt"', section: 'beta' }
		]);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.accepted.map((a) => a.units)).toEqual([2, 1]);
		expect(bucketOf(outcome.state, 'caf\uDCE9.txt', 'new', 1)).toBe('alpha');
		expect(bucketOf(outcome.state, 'caf\uDCE8.txt', 'new', 1)).toBe('beta');
	});

	it('applies valid items and rejects invalid ones in the same call', () => {
		const outcome = assign(diff, state, [
			{ file: 'src/app.ts', lines: '+2', section: 'alpha' },
			{ file: 'src/nope.ts', section: 'alpha' },
			{ file: 'src/app.ts', lines: '+3', section: 'beta' }
		]);
		expect(outcome.accepted.map((a) => a.index)).toEqual([0, 2]);
		expect(outcome.rejected.map((r) => [r.index, r.rejection.kind])).toEqual([[1, 'UnknownFile']]);
	});

	it('does not change the state it is given', () => {
		const before = JSON.stringify([...state.files.keys()]);
		assign(diff, state, [{ file: 'src/app.ts', section: 'alpha' }]);
		expect(bucketOf(state, 'src/app.ts', 'new', 2)).toBe('uncategorised');
		expect(JSON.stringify([...state.files.keys()])).toBe(before);
	});

	it('checks sections against the known ones when they are given', () => {
		const known = new Set([section('alpha')]);
		const outcome = assign(diff, state, [{ file: 'src/app.ts', section: 'beta' }], {
			knownSections: known
		});
		expect(outcome.rejected[0]?.rejection).toEqual({
			kind: 'UnknownSection',
			section: 'beta',
			known: ['alpha']
		});
	});
});

describe('assign with ranges that take nothing', () => {
	it('accepts an item when some of its ranges hold changed lines, and reports the ones that hold none', () => {
		const outcome = assign(diff, state, [
			{ file: 'src/app.ts', lines: '+1..+3,-4', section: 'alpha' }
		]);
		expect(outcome.rejected).toEqual([]);
		const [item] = outcome.accepted;
		expect(item?.units).toBe(2);
		expect(item?.rangesTakingNothing).toEqual({
			file: 'src/app.ts',
			ranges: [{ side: 'old', first: 4, last: 4 }]
		});
		expect(item?.rangesTakingNothing && describeRangesTakingNothing(item.rangesTakingNothing)).toBe(
			"src/app.ts: -4 holds no changed line and took nothing; the item's other ranges were assigned. Nothing more needs doing unless you meant other lines; use the +/- labels from get_diff to name them."
		);
	});

	it('takes an addition-only hunk named by both sides of its heading', () => {
		// The heading of this hunk is "@@ -10,7 +10,9 @@": nothing is deleted.
		const added = syntheticDiff([
			{
				path: 'src/new.ts',
				change: 'modified',
				hunks: [{ gap: 9, lines: [' ', '+', '+', ' ', ' ', '+', ' ', ' ', ' '] }]
			}
		]);
		const outcome = assign(added, initialState(added), [
			{ file: 'src/new.ts', lines: '-10..-16,+10..+18', section: 'alpha' }
		]);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.accepted[0]?.units).toBe(3);
		expect(outcome.accepted[0]?.rangesTakingNothing?.ranges).toEqual([
			{ side: 'old', first: 10, last: 16 }
		]);
		expect(outcome.uncategorised).toBe(0);
	});

	it('reports nothing when every range takes something', () => {
		const outcome = assign(diff, state, [{ file: 'src/app.ts', lines: '-2,+2', section: 'alpha' }]);
		expect(outcome.accepted[0]?.rangesTakingNothing).toBeUndefined();
	});
});

describe('assign rejections', () => {
	const reject = (request: AssignRequest): AssignRejection | undefined => {
		const outcome = assign(diff, state, [request]);
		expect(outcome.state).toBe(state);
		return outcome.rejected[0]?.rejection;
	};

	it('rejects an item whose ranges hold no changed line between them, naming the nearest ones', () => {
		expect(reject({ file: 'src/app.ts', lines: '+5..+9', section: 'alpha' })).toEqual({
			kind: 'NoChangedLines',
			file: 'src/app.ts',
			ranges: [{ side: 'new', first: 5, last: 9 }],
			nearest: [
				{ side: 'new', first: 2, last: 4 },
				{ side: 'new', first: 11, last: 11 }
			]
		});
		expect(reject({ file: 'src/app.ts', lines: '+5..+9,-4', section: 'alpha' })).toEqual({
			kind: 'NoChangedLines',
			file: 'src/app.ts',
			ranges: [
				{ side: 'new', first: 5, last: 9 },
				{ side: 'old', first: 4, last: 4 }
			],
			nearest: [
				{ side: 'old', first: 2, last: 3 },
				{ side: 'new', first: 2, last: 4 },
				{ side: 'new', first: 11, last: 11 }
			]
		});
	});

	it('names the changed lines on the other side when a side has none', () => {
		const rejection = reject({ file: 'src/app.test.ts', lines: '-1', section: 'alpha' });
		expect(rejection).toEqual({
			kind: 'NoChangedLines',
			file: 'src/app.test.ts',
			ranges: [{ side: 'old', first: 1, last: 1 }],
			nearest: [{ side: 'new', first: 1, last: 4 }]
		});
		expect(rejection && describeRejection(rejection)).toContain('has no deleted lines');
	});

	it('names only a few changed lines near the request, however large the file', () => {
		const big = syntheticDiff([
			{
				path: 'big.ts',
				change: 'modified',
				hunks: Array.from({ length: 400 }, () => ({ gap: 1, lines: [' ', '+', ' '] as const }))
			}
		]);
		const outcome = assign(big, initialState(big), [
			{ file: 'big.ts', lines: '+601', section: 'alpha' }
		]);
		const rejection = outcome.rejected[0]?.rejection;
		expect(rejection?.kind === 'NoChangedLines' && rejection.nearest.length).toBe(4);
		expect(rejection && describeRejection(rejection).length).toBeLessThan(400);
	});

	describe('in a file of 5,000 hunks', () => {
		const huge = syntheticDiff([
			{
				path: 'huge.ts',
				change: 'modified',
				hunks: Array.from({ length: 5_000 }, () => ({ gap: 1, lines: [' ', '+', ' '] as const }))
			}
		]);
		const hugeState = initialState(huge);
		const message = (request: AssignRequest): string => {
			const rejection = assign(huge, hugeState, [request]).rejected[0]?.rejection;
			if (rejection === undefined) throw new Error('not rejected');
			return describeRejection(rejection);
		};

		it('keeps a refusal of 5,000 empty ranges short, and builds it quickly', () => {
			const changed = huge.files[0]?.changed.new;
			const unchanged: string[] = [];
			for (let n = 1; unchanged.length < 5_000; n += 1) {
				if (changed?.has(n) !== true) unchanged.push(`+${String(n)}`);
			}
			const started = now();
			const text = message({ file: 'huge.ts', lines: unchanged.join(','), section: 'alpha' });
			expect(now() - started).toBeLessThan(100);
			expect(text.length).toBeLessThan(600);
			expect(text).toContain('+1,+2,+4,+5,+6,+8,+9,+10,+12,+13 and 4990 more hold no changed line');
			expect(text).toContain('Nearby: +3,+7,+11,+15,+19,+23,+27,+31,+35,+39.');
		});

		it('names the hunks of the file as a span, not one by one', () => {
			const malformed = message({ file: 'huge.ts', hunks: ['1', 'H2'], section: 'alpha' });
			expect(malformed).toContain('huge.ts has hunks h1 to h5000.');
			expect(malformed.length).toBeLessThan(400);
			const unknown = message({
				file: 'huge.ts',
				hunks: Array.from({ length: 2_000 }, (_, i) => `h${String(6_000 + i)}`),
				section: 'alpha'
			});
			expect(unknown).toBe(
				'huge.ts has no hunk h6000, h6001, h6002, h6003, h6004, h6005, h6006, h6007, h6008, h6009 and 1990 more. Its hunks are h1 to h5000.'
			);
		});
	});

	it('repeats at most 80 characters of what the agent wrote', () => {
		const long = 'x'.repeat(5_000);
		for (const request of [
			{ file: long, section: 'alpha' },
			{ file: 'src/app.ts', lines: long, section: 'alpha' },
			{ glob: `${long}[`, section: 'alpha' },
			{ file: 'src/app.ts', section: long },
			{ file: 'src/app.ts', role: long }
		]) {
			const rejection = assign(diff, state, [request]).rejected[0]?.rejection;
			expect(rejection && describeRejection(rejection).length).toBeLessThan(500);
		}
	});

	it.each<[AssignRequest, AssignRejection['kind']]>([
		[{ section: 'alpha' }, 'InvalidItem'],
		[{ file: 'src/app.ts', glob: '*.ts', section: 'alpha' }, 'InvalidItem'],
		[{ file: 'src/app.ts', hunks: ['h1'], lines: '+2', section: 'alpha' }, 'InvalidItem'],
		[{ lines: '+2', section: 'alpha' }, 'InvalidItem'],
		[{ file: 'src/app.ts', hunks: [], section: 'alpha' }, 'InvalidItem'],
		[{ file: 'src/app.ts' }, 'InvalidItem'],
		[{ file: 'src/app.ts', section: 'alpha', reason: 'why' }, 'InvalidItem'],
		[{ file: 'app.ts', section: 'alpha' }, 'UnknownFile'],
		[{ file: 'src/app.ts', hunks: ['h1', 'h7'], section: 'alpha' }, 'UnknownHunk'],
		[{ file: 'src/app.ts', hunks: ['first'], section: 'alpha' }, 'MalformedHunkId'],
		[{ file: 'assets/logo.png', lines: '+1', section: 'alpha' }, 'NoLinesInFile'],
		[{ file: 'src/app.ts', lines: '2..3', section: 'alpha' }, 'MalformedLines'],
		[{ glob: '[', section: 'alpha' }, 'MalformedGlob'],
		[{ glob: '[z-a]', section: 'alpha' }, 'MalformedGlob'],
		[{ glob: 'lib/**', section: 'alpha' }, 'GlobMatchesNothing'],
		[{ file: 'src/app.ts', section: 'Session Expiry' }, 'InvalidSectionId'],
		[{ file: 'src/app.ts', section: 'ignored' }, 'MissingReason'],
		[{ file: 'src/app.ts', section: 'ignored', reason: '  ' }, 'MissingReason'],
		[{ file: 'src/app.ts', role: 'docs' }, 'InvalidRole']
	])('rejects %j as %s', (request, kind) => {
		expect(reject(request)?.kind).toBe(kind);
	});

	it('says a malformed hunk id is not a hunk id, and lists the real ones', () => {
		for (const hunks of [['1'], ['H2'], ['h1', 'hunk 2']]) {
			const rejection = reject({ file: 'src/app.ts', hunks, section: 'alpha' });
			expect(rejection).toEqual({
				kind: 'MalformedHunkId',
				file: 'src/app.ts',
				hunks: hunks.filter((h) => h !== 'h1'),
				known: ['h1', 'h2']
			});
			const message = rejection === undefined ? '' : describeRejection(rejection);
			expect(message).toContain('not a hunk id');
			expect(message).toContain('h1, h2');
			expect(message).not.toContain('no lines');
		}
	});

	it('says a file with no lines has no hunks when given a malformed hunk id', () => {
		const rejection = reject({ file: 'assets/logo.png', hunks: ['1'], section: 'alpha' });
		expect(rejection).toMatchObject({ kind: 'MalformedHunkId', known: [] });
		expect(rejection && describeRejection(rejection)).toMatch(/whole file/);
	});

	it('reports a malformed hunk id in a file that is not in the diff as an unknown file', () => {
		expect(reject({ file: 'app.ts', hunks: ['1'], section: 'alpha' })).toEqual({
			kind: 'UnknownFile',
			file: 'app.ts',
			similar: ['src/app.ts']
		});
	});

	it.each(['./src/app.ts', 'a/src/app.ts', 'b/src/app.ts', '/src/app.ts'])(
		'suggests the path without the prefix in %j',
		(file) => {
			const rejection = reject({ file, section: 'alpha' });
			expect(rejection).toEqual({ kind: 'UnknownFile', file, similar: ['src/app.ts'] });
			expect(rejection && describeRejection(rejection)).toContain('Did you mean src/app.ts?');
		}
	);

	it('suggests the path the agent probably meant', () => {
		expect(reject({ file: 'app.ts', section: 'alpha' })).toEqual({
			kind: 'UnknownFile',
			file: 'app.ts',
			similar: ['src/app.ts']
		});
	});

	it('explains every rejection in words the agent can act on', () => {
		const requests: readonly AssignRequest[] = [
			{ section: 'alpha' },
			{ file: 'app.ts', section: 'alpha' },
			{ file: 'nope/x.ts', section: 'alpha' },
			{ file: 'src/app.ts', hunks: ['h7'], section: 'alpha' },
			{ file: 'src/app.ts', hunks: ['1'], section: 'alpha' },
			{ file: 'assets/logo.png', hunks: ['h1'], section: 'alpha' },
			{ file: 'src/app.ts', lines: '+1', section: 'alpha' },
			{ file: 'assets/logo.png', lines: '+1', section: 'alpha' },
			{ file: 'src/app.ts', lines: 'x', section: 'alpha' },
			{ glob: '[', section: 'alpha' },
			{ glob: 'lib/**', section: 'alpha' },
			{ file: 'src/app.ts', section: 'uncategorised' },
			{ file: 'src/app.ts', section: 'Bad' },
			{ file: 'src/app.ts', section: 'ignored' },
			{ file: 'src/app.ts', role: 'docs' }
		];
		for (const request of requests) {
			const rejection = reject(request);
			expect(rejection).toBeDefined();
			if (rejection !== undefined) expect(describeRejection(rejection).length).toBeGreaterThan(30);
		}
		const unknownSection = assign(diff, state, [{ file: 'src/app.ts', section: 'beta' }], {
			knownSections: new Set()
		}).rejected[0]?.rejection;
		expect(unknownSection && describeRejection(unknownSection)).toMatch(/upsert_sections/);
	});
});

// --- Properties -----------------------------------------------------------------

/** Every unit of a file, as keys `old:3`, `new:4` or `file`. */
function unitKeys(file: DiffFile): readonly string[] {
	if (!file.hasLines) return ['file'];
	return [
		...[...file.changed.old.values()].map((n) => `old:${String(n)}`),
		...[...file.changed.new.values()].map((n) => `new:${String(n)}`)
	];
}

function assignmentOf(s: AssignmentState, file: DiffFile, key: string): Assignment | undefined {
	const assignment = s.files.get(file.file.path);
	if (assignment?.kind !== 'lines') return assignment?.assignment;
	const [side, line] = key.split(':');
	return (side === 'old' ? assignment.old : assignment.new).get(Number(line));
}

/** A request built from what is in the diff, valid or not. */
function arbitraryRequest(d: Diff): fc.Arbitrary<AssignRequest> {
	const paths = [...d.files.map((f) => f.file.path), ...MISSING_PATHS];
	const destination = fc.record(
		{
			section: fc.constantFrom(...SECTIONS),
			reason: fc.constantFrom('Generated', ''),
			role: fc.constantFrom('code', 'test', 'snapshot', 'docs')
		},
		{ requiredKeys: [] }
	);
	const label = fc.tuple(fc.constantFrom('+', '-'), fc.integer({ min: 1, max: 30 }), fc.nat(4));
	const target = fc.oneof(
		fc.constantFrom(...paths).map((file) => ({ file })),
		fc.constantFrom(...GLOBS).map((glob) => ({ glob })),
		fc
			.tuple(
				fc.constantFrom(...paths),
				fc.array(fc.constantFrom('h1', 'h2', 'h3', 'h9'), { maxLength: 3 })
			)
			.map(([file, hunks]) => ({ file, hunks })),
		fc
			.tuple(fc.constantFrom(...paths), fc.array(label, { minLength: 1, maxLength: 3 }))
			.map(([file, labels]) => ({
				file,
				lines: labels
					.map(([s, n, w]) => (w === 0 ? `${s}${n}` : `${s}${n}..${s}${n + w}`))
					.join(',')
			}))
	);
	return fc.tuple(target, destination).map(([t, dest]) => ({ ...t, ...dest }));
}

const scenario = arbitraryDiff.chain((d) =>
	fc.tuple(
		fc.constant(d),
		fc.array(fc.array(arbitraryRequest(d), { maxLength: 4 }), { maxLength: 6 })
	)
);

/** Any value at all in each field the agent may send, including nonsense. */
const anyRequest: fc.Arbitrary<AssignRequest> = fc.record(
	{
		file: fc.oneof(fc.string({ unit: 'binary', maxLength: 10 }), fc.constantFrom('src/app.ts')),
		glob: fc.string({ unit: 'binary', maxLength: 10 }),
		hunks: fc.array(fc.string({ unit: 'binary', maxLength: 4 }), { maxLength: 3 }),
		lines: fc.string({ unit: 'binary', maxLength: 12 }),
		section: fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom(...SECTIONS)),
		reason: fc.string({ maxLength: 8 }),
		role: fc.string({ maxLength: 6 })
	},
	{ requiredKeys: [] }
);

describe('assign properties', () => {
	it('never throws, whatever the items, and answers every item once', () => {
		fc.assert(
			fc.property(arbitraryDiff, fc.array(anyRequest, { maxLength: 5 }), (d, requests) => {
				const outcome = assign(d, initialState(d), requests);
				const answered = [...outcome.accepted, ...outcome.rejected].map((a) => a.index);
				expect(answered.sort((a, b) => a - b)).toEqual(requests.map((_, i) => i));
				for (const { rejection } of outcome.rejected) {
					expect(describeRejection(rejection).length).toBeGreaterThan(0);
				}
			}),
			{ numRuns: 200 }
		);
	});

	it('keeps every change unit in exactly one bucket after any sequence of calls', () => {
		fc.assert(
			fc.property(scenario, ([d, calls]) => {
				let s = initialState(d);
				for (const call of calls) s = assign(d, s, call).state;
				let total = 0;
				for (const file of d.files) {
					const assignment = s.files.get(file.file.path);
					expect(assignment).toBeDefined();
					if (assignment?.kind === 'lines') {
						expect(file.hasLines).toBe(true);
						expect(assignment.old.domain.equals(file.changed.old)).toBe(true);
						expect(assignment.new.domain.equals(file.changed.new)).toBe(true);
						total += assignment.old.size + assignment.new.size;
					} else if (assignment?.kind === 'file') {
						expect(file.hasLines).toBe(false);
						total += 1;
					}
				}
				expect(total).toBe(d.unitCount);
				expect(s.files.size).toBe(d.files.length);
			}),
			{ numRuns: 60 }
		);
	});

	it('changes only the units an item targets, as the rules say', () => {
		fc.assert(
			fc.property(scenario, ([d, calls]) => {
				let s = initialState(d);
				for (const request of calls.flat()) {
					const outcome = assign(d, s, [request]);
					const accepted = outcome.accepted.length === 1;
					if (!accepted) expect(outcome.state).toBe(s);
					// A whole file or a glob, with a destination, takes only uncategorised units.
					const wholeFiles = request.hunks === undefined && request.lines === undefined;
					const onlyUncategorised = wholeFiles && request.section !== undefined;
					let taken = 0;
					for (const file of d.files) {
						const targeted = targetedKeys(file, request);
						for (const key of unitKeys(file)) {
							const before = assignmentOf(s, file, key);
							const after = assignmentOf(outcome.state, file, key);
							if (before === undefined || after === undefined) throw new Error('lost a unit');
							const takes =
								accepted &&
								targeted.has(key) &&
								(!onlyUncategorised || before.bucket.kind === 'uncategorised');
							if (!takes) {
								expect(sameAssignment(before, after)).toBe(true);
							} else {
								taken += 1;
								if (request.role !== undefined) expect(after.role).toBe(request.role);
								if (request.section === 'ignored') expect(after.bucket.kind).toBe('ignored');
								else if (request.section !== undefined) {
									expect(after.bucket).toEqual({ kind: 'section', section: request.section });
								} else expect(after.bucket).toEqual(before.bucket);
							}
						}
					}
					expect(outcome.accepted[0]?.units ?? 0).toBe(taken);
					// An item of line ranges is refused only when none of its ranges holds a
					// changed line on its side; the ranges that hold none are reported.
					const file = d.files.find((f) => f.file.path === request.file);
					if (request.lines !== undefined && file?.hasLines === true) {
						const empty = rangesWithoutChanges(file, request.lines);
						const refused = outcome.rejected[0]?.rejection.kind === 'NoChangedLines';
						if (refused) expect(empty.all).toBe(true);
						if (accepted) {
							expect(empty.all).toBe(false);
							expect(outcome.accepted[0]?.rangesTakingNothing?.ranges.length ?? 0).toBe(
								empty.count
							);
						}
					}
					s = outcome.state;
				}
			}),
			{ numRuns: 60 }
		);
	});
});

/**
 * How many ranges of a well-formed `lines` value hold no changed line of the
 * file, and whether that is all of them.
 */
function rangesWithoutChanges(
	file: DiffFile,
	lines: string
): { readonly count: number; readonly all: boolean } {
	const parts = lines.split(',');
	const count = parts.filter((part) => {
		const match = /^([+-])(\d+)(?:\.\.[+-](\d+))?$/.exec(part);
		if (match === null) return false;
		const set = match[1] === '+' ? file.changed.new : file.changed.old;
		const first = Number(match[2]);
		const last = Number(match[3] ?? match[2]);
		for (let n = first; n <= last; n += 1) if (set.has(n)) return false;
		return true;
	}).length;
	return { count, all: count === parts.length };
}

/**
 * An independent model of which units a request targets in a file, before the
 * whole-file rule about uncategorised units is applied.
 */
function targetedKeys(file: DiffFile, request: AssignRequest): ReadonlySet<string> {
	const all = new Set(unitKeys(file));
	if (request.glob !== undefined) {
		const name = file.file.path;
		const matchers: Readonly<Record<string, (p: string) => boolean>> = {
			'*.ts': (p) => p.endsWith('.ts'),
			'src/**': (p) => p.startsWith('src/'),
			'**/*.md': (p) => p.endsWith('.md'),
			'*.png': (p) => p.endsWith('.png'),
			'vendor/': (p) => p.startsWith('vendor/')
		};
		return matchers[request.glob]?.(name) === true ? all : new Set();
	}
	if (request.file !== file.file.path) return new Set();
	if (request.hunks !== undefined) {
		const keys = new Set<string>();
		for (const id of request.hunks) {
			const lines = [...file.hunkLines.entries()].find(([h]) => h === id)?.[1];
			for (const n of lines?.old.values() ?? []) keys.add(`old:${String(n)}`);
			for (const n of lines?.new.values() ?? []) keys.add(`new:${String(n)}`);
		}
		return keys;
	}
	if (request.lines !== undefined) {
		const keys = new Set<string>();
		for (const part of request.lines.split(',')) {
			const match = /^([+-])(\d+)(?:\.\.[+-](\d+))?$/.exec(part);
			if (match === null) continue;
			const side = match[1] === '+' ? 'new' : 'old';
			const first = Number(match[2]);
			const last = Number(match[3] ?? match[2]);
			for (let n = first; n <= last; n += 1) keys.add(`${side}:${String(n)}`);
		}
		return keys;
	}
	return all;
}
