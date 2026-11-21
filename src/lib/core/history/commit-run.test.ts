import { describe, expect, it } from 'vitest';
import { reportTitle } from '../reports/describe-report.ts';
import { parseGitSourceSpec } from '../sources/git-source-spec.ts';
import { commitCountOf } from './commit-count.tiny.ts';
import { describeCommitRun, type CommitRun } from './commit-run.ts';
import { parseRunSubject, RUN_SUBJECT_LENGTH, runSubjectOf } from './run-subject.tiny.ts';
import { subjectLineOf } from './subject-line.tiny.ts';

function run(commits: number, oldest: string, newest: string): CommitRun {
	return {
		commits: commitCountOf(commits),
		oldest: runSubjectOf(subjectLineOf(oldest)),
		newest: runSubjectOf(subjectLineOf(newest))
	};
}

describe('a run of commits as a title', () => {
	it('says how many commits it is, and the subjects of its oldest and newest', () => {
		expect(describeCommitRun(run(3, 'Add a discount rate', 'Say which code was used'), false)).toBe(
			'3 commits: “Add a discount rate” to “Say which code was used”'
		);
		expect(describeCommitRun(run(2, 'Add prices', 'Show the total'), false)).toBe(
			'2 commits: “Add prices” and “Show the total”'
		);
		expect(describeCommitRun(run(1, 'Add prices', 'Add prices'), false)).toBe(
			'1 commit: “Add prices”'
		);
		expect(describeCommitRun(run(1200, 'A', 'B'), false)).toBe('1,200 commits: “A” to “B”');
	});

	it('says so when the run starts at the repository’s first commit', () => {
		expect(describeCommitRun(run(5, 'Start the shop', 'Add prices'), true)).toBe(
			'The first 5 commits: “Start the shop” to “Add prices”'
		);
		expect(describeCommitRun(run(2, 'Start the shop', 'Add prices'), true)).toBe(
			'The first 2 commits: “Start the shop” and “Add prices”'
		);
		expect(describeCommitRun(run(1, 'Start the shop', 'Start the shop'), true)).toBe(
			'The first commit: “Start the shop”'
		);
	});

	it('writes out what cannot be seen in a subject, cuts a long one short, and names one with no message', () => {
		const title = describeCommitRun(run(3, 'Fix ‮evil‬', 'x'.repeat(90)), false);
		expect(title).toBe(`3 commits: “Fix \\u202Eevil\\u202C” to “${'x'.repeat(59)}…”`);
		expect(describeCommitRun(run(2, '', 'Tidy'), false)).toBe(
			'2 commits: a commit with no message and “Tidy”'
		);
	});

	it('titles a report by its run when it has one, and by its source otherwise', () => {
		const from = '0123456789abcdef0123456789abcdef01234567';
		const to = 'abcdef0123456789abcdef0123456789abcdef01';
		const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
		const spec = (text: string) => {
			const parsed = parseGitSourceSpec(text);
			if (!parsed.ok) throw new Error(`not a source: ${text}`);
			return parsed.value;
		};
		const kept = run(3, 'Add a discount rate', 'Say which code was used');
		expect(reportTitle({ kind: 'git', spec: spec(`${from}...${to}`), run: kept })).toBe(
			'3 commits: “Add a discount rate” to “Say which code was used”'
		);
		expect(reportTitle({ kind: 'git', spec: spec(`${empty}...${to}`), run: kept })).toBe(
			'The first 3 commits: “Add a discount rate” to “Say which code was used”'
		);
		// Opened before runs were kept, or two ids that are not a run.
		expect(reportTitle({ kind: 'git', spec: spec(`${from}...${to}`), run: undefined })).toBe(
			'Commit abcdef0 compared with commit 0123456'
		);
		expect(reportTitle({ kind: 'git', spec: spec(`${empty}...${to}`), run: undefined })).toBe(
			'Every commit up to abcdef0'
		);
		expect(reportTitle({ kind: 'git', spec: spec('working-tree'), run: undefined })).toBe(
			'Uncommitted changes'
		);
	});
});

describe('a subject as a run keeps it', () => {
	it('keeps the first characters of a long subject, never half of one', () => {
		const long = `${'é'.repeat(RUN_SUBJECT_LENGTH - 1)}😀😀`;
		const kept = runSubjectOf(subjectLineOf(long));
		expect(kept).toBe(`${'é'.repeat(RUN_SUBJECT_LENGTH - 1)}😀`);
		expect(kept.isWellFormed()).toBe(true);
		expect(parseRunSubject(kept)).toEqual({ ok: true, value: kept });
		expect(runSubjectOf(subjectLineOf('Short'))).toBe('Short');
	});

	it('refuses what could not have been kept', () => {
		expect(parseRunSubject('').ok).toBe(true);
		expect(parseRunSubject('x'.repeat(RUN_SUBJECT_LENGTH)).ok).toBe(true);
		for (const bad of ['x'.repeat(RUN_SUBJECT_LENGTH + 1), 'two\nlines', 'a\0b', '\ud800']) {
			expect(parseRunSubject(bad).ok).toBe(false);
		}
	});
});
