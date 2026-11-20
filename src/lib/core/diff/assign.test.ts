import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryDiff,
	GLOBS,
	MISSING_PATHS,
	SECTIONS,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { parseSectionId, type SectionId } from '../section-id.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { assign, describeRejection, type AssignRejection, type AssignRequest } from './assign.ts';
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

describe('assign rejections', () => {
	const reject = (request: AssignRequest): AssignRejection | undefined => {
		const outcome = assign(diff, state, [request]);
		expect(outcome.state).toBe(state);
		return outcome.rejected[0]?.rejection;
	};

	it('says which requested lines are not changed lines', () => {
		expect(reject({ file: 'src/app.ts', lines: '+1..+3,-4', section: 'alpha' })).toEqual({
			kind: 'NotChangedLines',
			file: 'src/app.ts',
			notChanged: [
				{ side: 'old', first: 4, last: 4 },
				{ side: 'new', first: 1, last: 1 }
			],
			changed: [
				{ side: 'old', first: 2, last: 3 },
				{ side: 'new', first: 2, last: 4 },
				{ side: 'new', first: 11, last: 11 }
			]
		});
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
		[{ file: 'src/app.ts', hunks: ['first'], section: 'alpha' }, 'UnknownHunk'],
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
					s = outcome.state;
				}
			}),
			{ numRuns: 60 }
		);
	});
});

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
