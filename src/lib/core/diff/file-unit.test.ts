/**
 * When a file has a file-level unit (DESIGN 4.1), what a person reads for it,
 * and that everything that counts units, sorts them or ticks them agrees.
 */
import { describe, expect, it } from 'vitest';
import { renderAgentFile } from './agent-text.ts';
import { assign } from './assign.ts';
import { coverage, describeWarning } from './coverage.ts';
import { parseDiffTreeOutput } from './diff-tree-output.ts';
import { makeDiff, type Diff, type DiffFile } from './diff.ts';
import { describeFileChange, describeFileUnit } from './file-unit.ts';
import { sectionView, testsSeparateView, type GroupKey } from './slices.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { initialState } from './state.ts';
import { autoIgnore } from './auto-ignore.ts';
import { groupKeyId } from '../group-key-id.tiny.ts';
import { markReviewed } from '../review/mark-reviewed.ts';
import { reviewProgress } from '../review/progress.ts';
import { fileUnitReviewed, NO_MARKS, reviewedLines } from '../review/reviewed-marks.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { frameOf, NO_PART_MARKS } from '../viewer/parts.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const NONE = '0'.repeat(40);

interface Change {
	/** `:old new oldBlob newBlob STATUS`, then the path or paths. */
	readonly raw: string;
	readonly patch: string;
}

const HUNK = '@@ -1 +1 @@\n-before\n+after\n';

function change(
	status: string,
	modes: readonly [string, string],
	paths: readonly string[],
	header: string,
	body = ''
): Change {
	const [oldMode, newMode] = modes;
	const oldBlob = oldMode === '000000' ? NONE : A;
	const newBlob = newMode === '000000' ? NONE : status.startsWith('R') && body === '' ? A : B;
	const [from = '', to = from] = paths;
	return {
		raw: `:${oldMode} ${newMode} ${oldBlob} ${newBlob} ${status}\0${paths.join('\0')}\0`,
		patch: `diff --git a/${from} b/${to}\n${header}${body === '' ? '' : `--- a/${from}\n+++ b/${to}\n${body}`}`
	};
}

function diffOf(...changes: readonly Change[]): Diff {
	const text = `${changes.map((c) => c.raw).join('')}\0${changes.map((c) => c.patch).join('')}`;
	const files = parseDiffTreeOutput(new TextEncoder().encode(text));
	if (!files.ok) throw new Error(JSON.stringify(files.error));
	const diff = makeDiff(files.value);
	if (!diff.ok) throw new Error('duplicate path');
	return diff.value;
}

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

function sectionGroup(id: string): GroupKey {
	const parsed = parseSectionId(id);
	if (!parsed.ok) throw new Error(id);
	return { kind: 'section', section: parsed.value };
}

function only(diff: Diff): DiffFile {
	const [file] = diff.files;
	if (file === undefined) throw new Error('no file');
	return file;
}

const cases = {
	edited: change('M', ['100644', '100644'], ['plain.ts'], 'index a..b 100644\n', HUNK),
	added: change(
		'A',
		['000000', '100644'],
		['new.ts'],
		'new file mode 100644\n',
		'@@ -0,0 +1 @@\n+new\n'
	),
	addedExecutable: change(
		'A',
		['000000', '100755'],
		['new.sh'],
		'new file mode 100755\n',
		'@@ -0,0 +1 @@\n+echo hi\n'
	),
	deleted: change(
		'D',
		['100644', '000000'],
		['old.ts'],
		'deleted file mode 100644\n',
		'@@ -1 +0,0 @@\n-old\n'
	),
	renamedWithEdits: change(
		'R090',
		['100644', '100644'],
		['src/old.ts', 'src/new.ts'],
		'similarity index 90%\nrename from src/old.ts\nrename to src/new.ts\nindex a..b 100644\n',
		HUNK
	),
	copiedWithEdits: change(
		'C090',
		['100644', '100644'],
		['src/source.ts', 'src/copy.ts'],
		'similarity index 90%\ncopy from src/source.ts\ncopy to src/copy.ts\nindex a..b 100644\n',
		HUNK
	),
	madeExecutableWithEdits: change(
		'M',
		['100644', '100755'],
		['run.sh'],
		'old mode 100644\nnew mode 100755\nindex a..b\n',
		HUNK
	),
	noLongerExecutable: change(
		'M',
		['100755', '100644'],
		['run.sh'],
		'old mode 100755\nnew mode 100644\nindex a..b\n',
		HUNK
	),
	becameLink: {
		raw: `:100644 120000 ${A} ${B} T\0link.txt\0`,
		patch:
			'diff --git a/link.txt b/link.txt\ndeleted file mode 100644\nindex a..0\n--- a/link.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-link me\n' +
			'diff --git a/link.txt b/link.txt\nnew file mode 120000\nindex 0..b\n--- /dev/null\n+++ b/link.txt\n@@ -0,0 +1 @@\n+target.txt\n\\ No newline at end of file\n'
	},
	becameSubmodule: {
		raw: `:100644 160000 ${A} ${C} T\0lib\0`,
		patch:
			'diff --git a/lib b/lib\ndeleted file mode 100644\nindex a..0\n--- a/lib\n+++ /dev/null\n@@ -1 +0,0 @@\n-was a file\n' +
			`diff --git a/lib b/lib\nnew file mode 160000\nindex 0..c\n--- /dev/null\n+++ b/lib\n@@ -0,0 +1 @@\n+Subproject commit ${C}\n`
	},
	pureRename: change(
		'R100',
		['100644', '100644'],
		['before.txt', 'after.txt'],
		'similarity index 100%\nrename from before.txt\nrename to after.txt\n'
	),
	modeOnly: change('M', ['100644', '100755'], ['tool.sh'], 'old mode 100644\nnew mode 100755\n'),
	binary: change(
		'M',
		['100644', '100644'],
		['logo.png'],
		'index a..b 100644\nBinary files a/logo.png and b/logo.png differ\n'
	),
	emptyAdded: change('A', ['000000', '100644'], ['empty.txt'], 'new file mode 100644\nindex 0..e\n')
} satisfies Record<string, Change>;

describe('the file-level unit', () => {
	it.each([
		// Something about the file itself changed, beside its lines.
		['renamedWithEdits', true, true, 'renamed from src/old.ts', 'changed, renamed from src/old.ts'],
		[
			'copiedWithEdits',
			true,
			true,
			'copied from src/source.ts',
			'changed, copied from src/source.ts'
		],
		['madeExecutableWithEdits', true, true, 'made executable', 'changed, made executable'],
		['noLongerExecutable', true, true, 'no longer executable', 'changed, no longer executable'],
		['becameLink', true, true, 'became a link', 'became a link'],
		// No lines: the unit is the whole change.
		[
			'becameSubmodule',
			false,
			true,
			'became a submodule, submodule',
			'became a submodule, submodule'
		],
		['pureRename', false, true, 'renamed from before.txt', 'renamed from before.txt'],
		['modeOnly', false, true, 'made executable', 'made executable'],
		['binary', false, true, 'changed, binary file', 'changed, binary file'],
		['emptyAdded', false, true, 'added, empty file', 'added'],
		// Lines only: being added or deleted, or a new file's mode, is not a change to the file itself.
		['edited', true, false, undefined, 'changed'],
		['added', true, false, undefined, 'added'],
		['addedExecutable', true, false, undefined, 'added'],
		['deleted', true, false, undefined, 'deleted']
	] as const)('%s: lines %s, file-level unit %s', (name, lines, unit, words, listed) => {
		const file = only(diffOf(cases[name]));
		expect(file.hasLines).toBe(lines);
		expect(file.hasFileUnit).toBe(unit);
		const lineCount = file.changed.old.size + file.changed.new.size;
		expect(file.unitCount).toBe(lineCount + (unit ? 1 : 0));
		if (words !== undefined) expect(describeFileUnit(file.file)).toBe(words);
		expect(describeFileChange(file.file)).toBe(listed);
	});

	const diff = diffOf(cases.madeExecutableWithEdits, cases.binary, cases.renamedWithEdits);
	const run = path('run.sh');
	const renamed = path('src/new.ts');

	it('is labelled `file` in the agent text, and `"lines": "file"` takes it alone', () => {
		const text = renderAgentFile(only(diffOf(cases.madeExecutableWithEdits)));
		expect(text.split('\n').slice(0, 4)).toEqual([
			'## run.sh',
			'modified, mode 100644 → 100755',
			'file made executable',
			'@@ h1 -1,1 +1,1 @@'
		]);
		const outcome = assign(diff, initialState(diff), [
			{ file: 'run.sh', lines: 'file', section: 'modes' },
			{ file: 'src/new.ts', lines: 'file,+1', section: 'moves' }
		]);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.accepted.map((a) => a.units)).toEqual([1, 2]);
		const runState = outcome.state.files.get(run);
		expect(runState?.file?.bucket).toEqual({ kind: 'section', section: 'modes' });
		expect(runState?.new.get(1)?.bucket.kind).toBe('uncategorised');
		expect(outcome.state.files.get(renamed)?.old.get(1)?.bucket.kind).toBe('uncategorised');
		// Hunks are lines only; a whole file takes what is left, the file-level unit with it.
		const hunks = assign(diff, initialState(diff), [
			{ file: 'run.sh', hunks: ['h1'], section: 'x' }
		]);
		expect(hunks.accepted[0]?.units).toBe(2);
		expect(hunks.state.files.get(run)?.file?.bucket.kind).toBe('uncategorised');
		const whole = assign(diff, hunks.state, [{ file: 'run.sh', section: 'y' }]);
		expect(whole.accepted[0]?.units).toBe(1);
		expect(whole.state.files.get(run)?.file?.bucket).toEqual({ kind: 'section', section: 'y' });
	});

	it('refuses `file` for a file whose name, mode and kind did not change', () => {
		const plain = diffOf(cases.edited);
		const outcome = assign(plain, initialState(plain), [
			{ file: 'plain.ts', lines: 'file', section: 'x' }
		]);
		expect(outcome.rejected.map((r) => r.rejection.kind)).toEqual(['NoFileUnit']);
	});

	it('is counted, listed and warned about like any unit', () => {
		const state = assign(diff, initialState(diff), [
			{ file: 'run.sh', lines: '-1,+1', section: 'code' },
			{ file: 'run.sh', lines: 'file', role: 'test' }
		]).state;
		const result = coverage(diff, state, { sections: [] });
		expect(result.total.units).toBe(diff.unitCount);
		expect(result.uncategorised.units).toBe(diff.unitCount - 2);
		expect(result.remaining.find((u) => u.path === run)).toEqual({
			path: run,
			ranges: [],
			file: true
		});
		const tests = result.warnings.find((w) => w.kind === 'TestsOutsideSections');
		expect(tests === undefined ? '' : describeWarning(tests)).toMatch(/^run\.sh file: test lines/);
	});

	it('shows in the slice of its own group when the file is split, alone if need be', () => {
		const state = assign(diff, initialState(diff), [
			{ file: 'run.sh', lines: '-1,+1', section: 'code' },
			{ file: 'run.sh', lines: 'file', section: 'modes', role: 'test' }
		]).state;
		const view = sectionView(diff, state);
		const slicesOf = (id: string) =>
			view.groups.find((g) => groupKeyId(g.key) === id)?.slices.filter((s) => s.file.path === run);
		expect(
			slicesOf('section:code')?.map((s) => [s.fileUnit !== undefined, s.hunks.length, s.units])
		).toEqual([[false, 1, 2]]);
		expect(
			slicesOf('section:modes')?.map((s) => [s.fileUnit !== undefined, s.hunks.length, s.units])
		).toEqual([[true, 0, 1]]);
		// With tests apart, a test-role file-level unit is lifted with the section's tests.
		const separate = testsSeparateView(diff, state);
		expect(
			separate.groups
				.find((g) => groupKeyId(g.key) === 'tests:modes')
				?.slices.map((s) => [s.file.path, s.fileUnit !== undefined])
		).toEqual([[run, true]]);
		// The page's parts count it in its group only.
		const frame = frameOf(diff, state, NO_PART_MARKS, 'sections', []);
		const counts = frame.groups.flatMap((g) =>
			g.parts
				.filter((p) => p.file.file.path === 'run.sh')
				.map((p) => [g.key.kind === 'section' ? g.key.section : g.key.kind, p.added, p.removed])
		);
		expect(counts).toEqual([
			['modes', 0, 0],
			['code', 1, 1]
		]);
	});

	it('is ignored with its file by the built-in rules', () => {
		const lock = diffOf(
			change(
				'R090',
				['100644', '100644'],
				['old-lock.json', 'package-lock.json'],
				'similarity index 90%\nrename from old-lock.json\nrename to package-lock.json\nindex a..b 100644\n',
				HUNK
			)
		);
		const outcome = autoIgnore(lock, initialState(lock));
		expect(outcome.ignored[0]?.units).toBe(3);
		expect(outcome.state.files.get(path('package-lock.json'))?.file?.bucket.kind).toBe('ignored');
	});

	it('is ticked with its file and its part, and counted in progress', () => {
		const state = assign(diff, initialState(diff), [
			{ file: 'run.sh', lines: '-1,+1', section: 'code' },
			{ file: 'run.sh', lines: 'file', section: 'modes' }
		]).state;
		const sliceOnly = markReviewed(
			diff,
			state,
			NO_MARKS,
			{ kind: 'slice', group: sectionGroup('modes'), path: run },
			true,
			'sections'
		);
		expect(sliceOnly.ok && sliceOnly.value.units).toBe(1);
		if (!sliceOnly.ok) return;
		expect(fileUnitReviewed(sliceOnly.value.marks, run)).toBe(true);
		expect(reviewedLines(sliceOnly.value.marks, run, 'new').size).toBe(0);
		const whole = markReviewed(
			diff,
			state,
			NO_MARKS,
			{ kind: 'file', path: run },
			true,
			'sections'
		);
		expect(whole.ok && whole.value.units).toBe(3);
		if (!whole.ok) return;
		const progress = reviewProgress(diff, state, whole.value.marks, 'sections');
		expect(progress.files.get(run)?.tally).toMatchObject({ units: 3, reviewedUnits: 3, slices: 2 });
		expect(progress.overall.units).toBe(diff.unitCount);
		const undone = markReviewed(
			diff,
			state,
			whole.value.marks,
			{ kind: 'slice', group: sectionGroup('code'), path: run },
			false,
			'sections'
		);
		expect(undone.ok && fileUnitReviewed(undone.value.marks, run)).toBe(true);
	});
});
