/**
 * Synthetic `git diff-tree -r -z --patch-with-raw` output, for property tests and
 * size tests of the pure diff model. It follows the format of the recorded real
 * output in `src/lib/core/diff/fixtures/`, so the same parser reads both.
 *
 * Pure: no Node imports, no clock and no randomness, so core tests can use it.
 * The scale run takes its clock as an argument.
 */
import fc from 'fast-check';
import { describeDiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { parseDiffTreeOutput } from '#lib/core/diff/diff-tree-output.ts';
import { assign, type AssignRequest } from '#lib/core/diff/assign.ts';
import { coverage } from '#lib/core/diff/coverage.ts';
import { makeDiff, type Diff } from '#lib/core/diff/diff.ts';
import { initialState } from '#lib/core/diff/state.ts';
import { encodePathText } from '#lib/core/path-bytes.ts';
import { RangeSet } from '#lib/core/range-set.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import {
	fileReviewedOf,
	type FileReviewed,
	type ReviewedMarks
} from '#lib/core/review/reviewed-marks.ts';

export type LineKind = ' ' | '+' | '-';

export interface SyntheticHunk {
	/** Unchanged lines skipped before the hunk starts. */
	readonly gap: number;
	readonly lines: readonly LineKind[];
}

export type SyntheticFile =
	| {
			readonly path: string;
			readonly change: 'modified';
			readonly hunks: readonly SyntheticHunk[];
			/** Made executable as well, so it has a file-level unit beside its lines. */
			readonly executable?: boolean;
	  }
	| { readonly path: string; readonly change: 'added' | 'deleted'; readonly lines: number }
	| { readonly path: string; readonly change: 'binary' | 'empty-added' | 'mode' };

const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const NONE = '0'.repeat(40);

function rawRecord(file: SyntheticFile): string {
	const [oldMode, newMode, oldBlob, newBlob, status] = ((): readonly string[] => {
		switch (file.change) {
			case 'modified':
				return ['100644', file.executable === true ? '100755' : '100644', BLOB_A, BLOB_B, 'M'];
			case 'binary':
				return ['100644', '100644', BLOB_A, BLOB_B, 'M'];
			case 'mode':
				return ['100644', '100755', BLOB_A, BLOB_A, 'M'];
			case 'added':
				return ['000000', '100644', NONE, BLOB_B, 'A'];
			case 'empty-added':
				return ['000000', '100644', NONE, 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'A'];
			case 'deleted':
				return ['100644', '000000', BLOB_A, NONE, 'D'];
		}
	})();
	return `:${oldMode ?? ''} ${newMode ?? ''} ${oldBlob ?? ''} ${newBlob ?? ''} ${status ?? ''}\0${file.path}\0`;
}

function header(start: number, length: number): string {
	return length === 1 ? String(start) : `${String(start)},${String(length)}`;
}

function patch(file: SyntheticFile): string {
	const head = `diff --git a/${file.path} b/${file.path}\n`;
	switch (file.change) {
		case 'binary':
			return `${head}index ${BLOB_A}..${BLOB_B} 100644\nBinary files a/${file.path} and b/${file.path} differ\n`;
		case 'mode':
			return `${head}old mode 100644\nnew mode 100755\n`;
		case 'empty-added':
			return `${head}new file mode 100644\nindex ${NONE}..e69de29\n`;
		case 'added':
			return (
				`${head}new file mode 100644\n--- /dev/null\n+++ b/${file.path}\n` +
				`@@ -0,0 +${header(1, file.lines)} @@\n` +
				Array.from({ length: file.lines }, (_, i) => `+added ${String(i + 1)}\n`).join('')
			);
		case 'deleted':
			return (
				`${head}deleted file mode 100644\n--- a/${file.path}\n+++ /dev/null\n` +
				`@@ -${header(1, file.lines)} +0,0 @@\n` +
				Array.from({ length: file.lines }, (_, i) => `-deleted ${String(i + 1)}\n`).join('')
			);
		case 'modified': {
			const mode = file.executable === true ? 'old mode 100644\nnew mode 100755\n' : '';
			const parts = [`${head}${mode}--- a/${file.path}\n+++ b/${file.path}\n`];
			let oldNext = 1;
			let newNext = 1;
			for (const hunk of file.hunks) {
				oldNext += hunk.gap;
				newNext += hunk.gap;
				const oldLength = hunk.lines.filter((k) => k !== '+').length;
				const newLength = hunk.lines.filter((k) => k !== '-').length;
				const oldStart = oldLength === 0 ? oldNext - 1 : oldNext;
				const newStart = newLength === 0 ? newNext - 1 : newNext;
				parts.push(
					`@@ -${header(oldStart, oldLength)} +${header(newStart, newLength)} @@ heading\n`
				);
				for (const kind of hunk.lines) parts.push(`${kind}text\n`);
				oldNext += oldLength;
				newNext += newLength;
			}
			return parts.join('');
		}
	}
}

/** The diff-tree output git would write for these files, which must be sorted by path. */
export function syntheticDiffTreeOutput(files: readonly SyntheticFile[]): Uint8Array {
	if (files.length === 0) return new Uint8Array();
	// A path may hold U+DC80 to U+DCFF, which stand for bytes that are not UTF-8.
	return encodePathText(`${files.map(rawRecord).join('')}\0${files.map(patch).join('')}`);
}

/** The model of a synthetic diff. Throws if the model rejects it, which is a bug. */
export function syntheticDiff(files: readonly SyntheticFile[]): Diff {
	const parsed = parseDiffTreeOutput(syntheticDiffTreeOutput(files));
	if (!parsed.ok) throw new Error(describeDiffOutputError(parsed.error));
	const diff = makeDiff(parsed.value);
	if (!diff.ok) throw new Error(`Duplicate path ${diff.error.path}`);
	return diff.value;
}

// --- fast-check arbitraries -----------------------------------------------------

const hunk: fc.Arbitrary<SyntheticHunk> = fc
	.record({
		gap: fc.integer({ min: 0, max: 5 }),
		lines: fc.array(fc.constantFrom<LineKind>(' ', '+', '-', '+', '-'), {
			minLength: 1,
			maxLength: 12
		})
	})
	.filter((h) => h.lines.some((k) => k !== ' '));

/** Paths with directories, extensions and names that the built-in rules care about. */
const PATHS = [
	'README.md',
	'package-lock.json',
	'src/app.ts',
	'src/app.test.ts',
	'src/lib/util.ts',
	'src/__snapshots__/app.test.ts.snap',
	'docs/guide.md',
	// The bytes `caf`, E9, `.md`: not UTF-8 (see path-bytes.ts).
	'docs/caf\uDCE9.md',
	'assets/logo.png',
	'tests/e2e/login.ts',
	'vendor/lib/a.go'
];

const file = (path: string): fc.Arbitrary<SyntheticFile> =>
	fc.oneof(
		{
			weight: 6,
			arbitrary: fc
				.array(hunk, { minLength: 1, maxLength: 4 })
				.map((hunks) => ({ path, change: 'modified' as const, hunks }))
		},
		{
			weight: 1,
			arbitrary: fc
				.array(hunk, { minLength: 1, maxLength: 4 })
				.map((hunks) => ({ path, change: 'modified' as const, hunks, executable: true }))
		},
		{
			weight: 1,
			arbitrary: fc
				.integer({ min: 1, max: 8 })
				.map((lines) => ({ path, change: 'added' as const, lines }))
		},
		{
			weight: 1,
			arbitrary: fc
				.integer({ min: 1, max: 8 })
				.map((lines) => ({ path, change: 'deleted' as const, lines }))
		},
		{
			weight: 1,
			arbitrary: fc
				.constantFrom('binary' as const, 'empty-added' as const, 'mode' as const)
				.map((change) => ({ path, change }))
		}
	);

/** A random diff of up to all the paths above. */
export const arbitraryDiff: fc.Arbitrary<Diff> = fc
	.subarray([...PATHS].sort(), { minLength: 1 })
	.chain((paths) => fc.tuple(...paths.map(file)))
	.map((files) => syntheticDiff(files));

/** Paths that are not in any synthetic diff, for testing rejections. */
export const MISSING_PATHS = ['nope.ts', 'src/missing.ts'];

/** Globs, some of which match synthetic paths and some of which do not. */
export const GLOBS = ['*.ts', 'src/**', '**/*.md', 'nothing/**', '*.png', '[', 'vendor/'];

/** Section ids, the ignored bucket, and ids that are not valid. */
export const SECTIONS = ['alpha', 'beta', 'gamma', 'ignored', 'Not An Id'];

// --- assign requests -------------------------------------------------------------

/** A request built from what is in the diff, valid or not. */
export function arbitraryAssignRequest(d: Diff): fc.Arbitrary<AssignRequest> {
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

/** A random diff with a few `assign` calls of a few requests each. */
export const arbitraryAssignScenario: fc.Arbitrary<readonly [Diff, AssignRequest[][]]> =
	arbitraryDiff.chain((d) =>
		fc.tuple(
			fc.constant(d),
			fc.array(fc.array(arbitraryAssignRequest(d), { maxLength: 4 }), { maxLength: 6 })
		)
	);

// --- Reviewed marks ----------------------------------------------------------------

/** Marks for some of the diff's units, chosen by the flags in unit order. */
export function marksFrom(d: Diff, flags: readonly boolean[]): ReviewedMarks {
	let at = 0;
	const next = (): boolean => flags[at++ % Math.max(flags.length, 1)] ?? false;
	const files = new Map<RepoPath, FileReviewed>();
	for (const file of d.files) {
		const whole = file.hasFileUnit && next();
		const pick = (lines: RangeSet): RangeSet =>
			RangeSet.fromNumbers([...lines.values()].filter(next));
		const entry = fileReviewedOf(pick(file.changed.old), pick(file.changed.new), whole);
		if (entry !== undefined) files.set(file.file.path, entry);
	}
	return { files };
}

// --- Scale ----------------------------------------------------------------------

export interface ScaleRun {
	/** Milliseconds by `now` from git's output to coverage, not counting writing the output. */
	readonly elapsed: number;
	readonly unitCount: number;
	readonly uncategorised: number;
}

/**
 * Times the pure pipeline on `fileCount` files of 100 changed lines each: parse,
 * index, initial state, two `assign` items, coverage. A fifth of the files go to
 * one section by glob and ten lines of one file to another.
 */
export function runAtScale(fileCount: number, now: () => number): ScaleRun {
	// Each file: two hunks, each a run of 25 deleted and 25 added lines between context.
	const run: readonly LineKind[] = [
		' ',
		...Array<LineKind>(25).fill('-'),
		...Array<LineKind>(25).fill('+'),
		' '
	];
	const files: SyntheticFile[] = Array.from({ length: fileCount }, (_, i) => ({
		path: `src/module-${String(i).padStart(5, '0')}/file.ts`,
		change: 'modified',
		hunks: [
			{ gap: 10, lines: run },
			{ gap: 20, lines: run }
		]
	}));
	const output = syntheticDiffTreeOutput(files);
	const fifth = Math.floor(fileCount / 5);

	const started = now();
	const parsed = parseDiffTreeOutput(output);
	if (!parsed.ok) throw new Error(describeDiffOutputError(parsed.error));
	const diff = makeDiff(parsed.value);
	if (!diff.ok) throw new Error('duplicate path');
	const outcome = assign(diff.value, initialState(diff.value), [
		...Array.from({ length: fifth / 100 }, (_, i) => ({
			glob: `src/module-${String(i).padStart(3, '0')}??/**`,
			section: 'first'
		})),
		{
			file: `src/module-${String(fileCount - 1).padStart(5, '0')}/file.ts`,
			lines: '+12..+21',
			section: 'second'
		}
	]);
	if (outcome.rejected.length > 0) throw new Error('an item was rejected');
	const result = coverage(diff.value, outcome.state);
	return {
		elapsed: now() - started,
		unitCount: diff.value.unitCount,
		uncategorised: result.uncategorised.units
	};
}
