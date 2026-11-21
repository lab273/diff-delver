import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { assign } from '#lib/core/diff/assign.ts';
import { autoIgnore } from '#lib/core/diff/auto-ignore.ts';
import { parseGlobPattern } from '#lib/core/glob-pattern.tiny.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseLineRange } from '#lib/core/line-range.ts';
import { makeDiff, type Diff } from '#lib/core/diff/diff.ts';
import { initialState, type AssignmentState } from '#lib/core/diff/state.ts';
import { commitCountOf } from '#lib/core/history/commit-count.tiny.ts';
import { runSubjectOf } from '#lib/core/history/run-subject.tiny.ts';
import { subjectLineOf } from '#lib/core/history/subject-line.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import { andThen, ok } from '#lib/core/result.ts';
import type { Section } from '#lib/core/reports/report.ts';
import {
	NO_MARKS,
	sameReviewedMarks,
	type ReviewedMarks
} from '#lib/core/review/reviewed-marks.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseSectionTitle } from '#lib/core/section-title.tiny.ts';
import {
	assignmentRowsOf,
	assignmentStateFromRows,
	reviewedMarksFromRows,
	reviewedRowsOf,
	sameAssignmentState
} from '#lib/core/storage/stored-units.ts';
import { readSnapshotDiff } from '#lib/server/store/index.ts';
import { oddPathBytes, pathBytes } from '../../../../tests/support/diff-fixtures.ts';
import { tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { take, value } from '../../../../tests/support/git-source-helpers.ts';
import { aReport, aRevision, at, WORKTREE } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import {
	arbitraryAssignScenario,
	marksFrom,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { Database } from './database.ts';
import { assignmentRowsFor, replaceAssignmentRows } from './tables/assignments.ts';
import {
	deleteReportRow,
	everyReport,
	insertReport,
	openReportFor,
	reportById,
	setReportState
} from './tables/reports.ts';
import { replaceReviewedRows, reviewedRowsFor } from './tables/reviewed-marks.ts';
import { currentRevision, insertRevision } from './tables/revisions.ts';
import { replaceSections, sectionsOf } from './tables/sections.ts';
import { overviewOf, setOverview } from './tables/overviews.ts';
import { referenceRowsFor, replaceReferenceRows } from './tables/section-references.ts';

async function database(): Promise<Database> {
	return value(await Database.open(await tempDirectory(), settableClock(at(0))));
}

function section(id: string, title: string, summary?: string): Section {
	return {
		id: value(parseSectionId(id)),
		title: value(parseSectionTitle(title)),
		summary: summary === undefined ? undefined : value(parseAgentMarkdown(summary))
	};
}

/** Sections for every id the synthetic requests use. */
const SECTIONS = [section('alpha', 'Alpha'), section('beta', 'Beta'), section('gamma', 'Gamma')];

/** A new report and revision with the synthetic sections, for one round trip. */
function newRevision(db: Database, ids: ReturnType<typeof sequentialIds>): RevisionId {
	const report = ids.reportId();
	const revision = ids.revisionId();
	value(
		db.write((q) => {
			insertReport(q, aReport(report, undefined, { kind: 'staged' }));
			q.run("UPDATE reports SET state = 'closed', closed_reason = 'reviewer' WHERE id = ?", report);
			insertRevision(q, aRevision(revision, report));
			replaceSections(q, revision, SECTIONS);
			return ok(undefined);
		})
	);
	return revision;
}

function storeAndLoad(
	db: Database,
	revision: RevisionId,
	diff: Diff,
	state: AssignmentState,
	marks: ReviewedMarks
): { state: AssignmentState; marks: ReviewedMarks } {
	value(
		db.write((q) => {
			replaceAssignmentRows(q, revision, 'all', assignmentRowsOf(diff, state));
			replaceReviewedRows(q, revision, 'all', reviewedRowsOf(marks));
			return ok(undefined);
		})
	);
	return value(
		db.read((q) =>
			andThen(assignmentRowsFor(q, revision), (rows) =>
				andThen(assignmentStateFromRows(diff, rows), (loaded) =>
					andThen(reviewedRowsFor(q, revision), (marked) =>
						andThen(reviewedMarksFromRows(diff, marked), (loadedMarks) =>
							ok({ state: loaded, marks: loadedMarks })
						)
					)
				)
			)
		)
	);
}

describe('the tables', () => {
	it('give back a report, its revision and its sections as they were stored', async () => {
		const db = await database();
		const ids = sequentialIds();
		const report = aReport(ids.reportId());
		const revision = aRevision(ids.revisionId(), report.id);
		const sections = [
			section('second', 'Second'),
			section('first', 'First', '**Why** it *matters*')
		];
		value(
			db.write((q) => {
				insertReport(q, report);
				insertRevision(q, revision);
				replaceSections(q, revision.id, sections);
				return ok(undefined);
			})
		);
		const read = value(
			db.read((q) =>
				andThen(reportById(q, report.id), (r) =>
					andThen(currentRevision(q, report.id), (v) =>
						andThen(sectionsOf(q, revision.id), (s) => ok({ r, v, s }))
					)
				)
			)
		);
		expect(read).toEqual({ r: report, v: revision, s: sections });

		// Reordered and retitled in place; then the report closes.
		const reordered = [section('first', 'First, renamed'), section('second', 'Second')];
		value(
			db.write((q) => {
				replaceSections(q, revision.id, reordered);
				setReportState(q, report.id, { kind: 'closed', reason: 'reviewer' }, at(9_000));
				return ok(undefined);
			})
		);
		const after = value(
			db.read((q) => andThen(sectionsOf(q, revision.id), (s) => ok({ s, all: everyReport(q) })))
		);
		db.close();
		expect(after.s).toEqual(reordered);
		expect(after.all).toEqual([
			ok({ ...report, state: { kind: 'closed', reason: 'reviewer' }, lastActivityAt: 9_000 })
		]);
	});

	it('give back a report of a run of commits with its run, and say when the run cannot be read', async () => {
		const db = await database();
		const ids = sequentialIds();
		const range = value(
			parseGitSourceSpec(
				'0123456789abcdef0123456789abcdef01234567...abcdef0123456789abcdef0123456789abcdef01'
			)
		);
		const run = {
			commits: commitCountOf(3),
			oldest: runSubjectOf(subjectLineOf('Add a discount rate')),
			newest: runSubjectOf(subjectLineOf('Say which code \u202Ewas used'))
		};
		const plain = aReport(ids.reportId());
		const based = aReport(ids.reportId(), WORKTREE, range);
		const report = { ...based, source: { ...based.source, run } };
		value(
			db.write((q) => {
				insertReport(q, plain);
				insertReport(q, report);
				return ok(undefined);
			})
		);
		const read = value(
			db.read((q) =>
				andThen(reportById(q, report.id), (r) =>
					andThen(openReportFor(q, report.identity), (o) =>
						andThen(reportById(q, plain.id), (p) => ok({ r, o, p, all: everyReport(q) }))
					)
				)
			)
		);
		expect(read.r).toEqual(report);
		expect(read.o).toEqual(report);
		expect(read.p).toEqual(plain);
		expect(read.all.map((r) => (r.ok ? r.value.source.run : 'unreadable'))).toEqual([
			undefined,
			run
		]);

		// A row that holds what a run never does: the report is unreadable, and says which table.
		value(
			db.write((q) => {
				q.run(
					"UPDATE commit_runs SET oldest_subject = 'two\nlines' WHERE report_id = ?",
					report.id
				);
				return ok(undefined);
			})
		);
		const damaged = db.read((q) => reportById(q, report.id));
		expect(damaged.ok ? undefined : damaged.error).toMatchObject({
			kind: 'StoredRowInvalid',
			table: 'commit_runs'
		});
		const listed = value(db.read((q) => ok(everyReport(q))));
		expect(listed.map((r) => (r.ok ? r.value.id : [r.error.id, r.error.error.table]))).toEqual([
			plain.id,
			[report.id, 'commit_runs']
		]);

		// The run goes with its report.
		value(
			db.write((q) => {
				deleteReportRow(q, report.id);
				return ok(undefined);
			})
		);
		expect(value(db.read((q) => ok(q.all('SELECT count(*) AS n FROM commit_runs'))))[0]?.n).toBe(0);
		db.close();
	});

	it('give back an overview and cross-references, removed with their section, and refuse a damaged overview', async () => {
		const db = await database();
		const ids = sequentialIds();
		const report = aReport(ids.reportId());
		const revision = aRevision(ids.revisionId(), report.id);
		const alpha = value(parseSectionId('alpha'));
		const rows = new Map([
			[
				alpha,
				[
					{ path: value(parseRepoPath('a.ts')), units: { kind: 'file' } as const },
					{
						path: value(parseRepoPath('a.ts')),
						units: { kind: 'lines', range: value(parseLineRange('new', 3, 9)) } as const
					}
				]
			]
		]);
		value(
			db.write((q) => {
				insertReport(q, report);
				insertRevision(q, revision);
				replaceSections(q, revision.id, SECTIONS);
				replaceReferenceRows(q, revision.id, rows);
				setOverview(q, revision.id, value(parseAgentMarkdown('First')));
				setOverview(q, revision.id, value(parseAgentMarkdown('Second <b>raw</b>')));
				return ok(undefined);
			})
		);
		const read = value(
			db.read((q) =>
				andThen(referenceRowsFor(q, revision.id), (r) =>
					andThen(overviewOf(q, revision.id), (o) => ok({ r, o }))
				)
			)
		);
		expect(read).toEqual({ r: rows, o: 'Second <b>raw</b>' });

		value(
			db.write((q) => {
				replaceSections(q, revision.id, SECTIONS.slice(1));
				return ok(undefined);
			})
		);
		expect(value(db.read((q) => referenceRowsFor(q, revision.id))).size).toBe(0);

		value(
			db.write((q) => {
				q.run(
					"INSERT INTO section_references VALUES (?, 'beta', ?, 'new', 5, 5)",
					revision.id,
					repoPathBytes(value(parseRepoPath('a.ts')))
				);
				q.run("UPDATE overviews SET markdown = ' ' WHERE revision_id = ?", revision.id);
				return ok(undefined);
			})
		);
		expect([...value(db.read((q) => referenceRowsFor(q, revision.id))).keys()]).toEqual(['beta']);
		const blank = db.read((q) => overviewOf(q, revision.id));
		db.close();
		expect(blank.ok ? undefined : blank.error).toMatchObject({
			kind: 'StoredRowInvalid',
			table: 'overviews'
		});
	});

	it('store every path exactly, including paths that are not UTF-8 and differ only in such a byte', async () => {
		const repo = await useFixture(oddPathBytes);
		const who = await reviewer();
		const taken = value(await take(repo.dir, 'HEAD', who));
		const diff = value(makeDiff(value(await readSnapshotDiff(taken.snapshot))));
		expect(diff.files).toHaveLength(4);

		const [first, second, third] = diff.files.map((f) => f.file.path);
		const state = assign(diff, initialState(diff), [
			{ file: first ?? '', section: 'alpha' },
			{ file: second ?? '', section: 'ignored', reason: 'Not this one' },
			{ file: third ?? '', section: 'beta', role: 'test' }
		]).state;
		const marks = marksFrom(diff, [true, false]);

		const db = await database();
		const revision = newRevision(db, sequentialIds());
		const loaded = storeAndLoad(db, revision, diff, state, marks);
		const stored = value(db.read((q) => ok(q.all('SELECT DISTINCT path FROM assignments'))));
		db.close();

		expect(sameAssignmentState(diff, state, loaded.state)).toBe(true);
		expect(sameReviewedMarks(marks, loaded.marks)).toBe(true);
		const bytes = stored.map((r) => Buffer.from(r.path instanceof Uint8Array ? r.path : []));
		expect(bytes.map((b) => b.toString('hex')).sort()).toEqual(
			diff.files.map((f) => Buffer.from(repoPathBytes(f.file.path)).toString('hex')).sort()
		);
		expect(bytes.map((b) => b.toString('hex'))).toContain(
			Buffer.from(pathBytes('caf', 0xe9, '.txt')).toString('hex')
		);
	});

	it('give back units ignored by a project pattern, a built-in rule and the agent, each with its reason', async () => {
		const diff = syntheticDiff([
			{ path: 'docs/guide.md', change: 'added', lines: 2 },
			{ path: 'package-lock.json', change: 'added', lines: 1 },
			{ path: 'src/gen/api.ts', change: 'added', lines: 3 },
			{ path: 'src/app.ts', change: 'added', lines: 2 }
		]);
		const pattern = value(parseGlobPattern('docs/**'));
		const generated = new Set([value(parseRepoPath('src/gen/api.ts'))]);
		const sorted = autoIgnore(diff, initialState(diff), {
			projectPatterns: [pattern],
			markedGenerated: generated
		});
		const state = assign(diff, sorted.state, [
			{ file: 'src/app.ts', lines: '+2', section: 'ignored', reason: 'Only *spacing*' }
		]).state;
		const db = await database();
		const revision = newRevision(db, sequentialIds());
		const loaded = storeAndLoad(db, revision, diff, state, NO_MARKS);
		const rows = value(
			db.read((q) =>
				ok(
					q.all(
						"SELECT CAST(path AS TEXT) AS path, ignored_by, ignored_detail FROM assignments WHERE bucket = 'ignored' ORDER BY path"
					)
				)
			)
		);
		db.close();
		expect(sameAssignmentState(diff, state, loaded.state)).toBe(true);
		expect(rows.map((r) => ({ ...r }))).toEqual([
			{ path: 'docs/guide.md', ignored_by: 'pattern', ignored_detail: 'docs/**' },
			{ path: 'package-lock.json', ignored_by: 'rule', ignored_detail: 'lockfile' },
			{ path: 'src/app.ts', ignored_by: 'agent', ignored_detail: 'Only *spacing*' },
			{ path: 'src/gen/api.ts', ignored_by: 'rule', ignored_detail: 'linguist-generated' }
		]);
	});

	it('give back an equal state and equal marks for any state assign calls reach', async () => {
		const db = await database();
		const ids = sequentialIds();
		fc.assert(
			fc.property(
				arbitraryAssignScenario,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
				([diff, calls], flags) => {
					let state = initialState(diff);
					for (const call of calls) state = assign(diff, state, call).state;
					const marks = marksFrom(diff, flags);
					const loaded = storeAndLoad(db, newRevision(db, ids), diff, state, marks);
					expect(sameAssignmentState(diff, state, loaded.state)).toBe(true);
					expect(sameReviewedMarks(marks, loaded.marks)).toBe(true);
				}
			),
			{ numRuns: 40 }
		);
		db.close();
	});
});
