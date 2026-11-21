import { randomIds } from '#lib/server/system.ts';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock, type SettableClock } from '#lib/core/clock.ts';
import { assignedUnits } from '#lib/core/diff/state.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { deleteSnapshot, listSnapshots, listStores } from '#lib/server/store/index.ts';
import { snapshotGitSource } from '#lib/server/sources/git/index.ts';
import { oddPathBytes } from '../../../../tests/support/diff-fixtures.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import type { GitRepo } from '../../../../tests/support/git-repo.ts';
import { located, value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer, type Reviewer } from '../../../../tests/support/reviewer-git.ts';
import { Database, DATABASE_FILE } from '../db/index.ts';
import { GRACE_PERIOD } from '../store/index.ts';
import {
	describeClosedReason,
	describeReportError,
	ReportService,
	type LoadedReport,
	type OpenOutcome,
	type ReportError
} from './index.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';

/** The first version of a diff, which changes are made on until it is updated. */
const FIRST = value(parseRevisionNumber(1));

interface Setup {
	readonly repo: GitRepo;
	readonly who: Reviewer;
	readonly data: AbsolutePath;
	readonly clock: SettableClock;
	readonly service: ReportService;
	/** What the service wrote to its log. */
	readonly logged: string[];
}

/** A service on a fresh data directory, and a repository with one commit and uncommitted changes. */
async function setUp(): Promise<Setup> {
	const repo = await emptyRepo();
	await repo.write('src/app.ts', 'one\ntwo\nthree\n');
	await repo.write('README.md', '# App\n');
	await repo.commit('first');
	await repo.write('src/app.ts', 'one\n2\nthree\nfour\n');
	await repo.write('src/app.test.ts', 'test\n');
	await repo.write('package-lock.json', '{}\n');
	const who = await reviewer();
	const data = await tempDirectory();
	const clock = settableClock(at(1_700_000_000_000));
	const logged: string[] = [];
	const service = await serviceOn(data, clock, who, '', logged);
	return { repo, who, data, clock, service, logged };
}

async function serviceOn(
	data: AbsolutePath,
	clock: SettableClock,
	who: Reviewer,
	prefix = '',
	logged: string[] = []
): Promise<ReportService> {
	return value(
		await ReportService.open({
			dataDirectory: data,
			clock,
			ids: sequentialIds(prefix),
			repository: { gitEnv: who.gitEnv },
			log: (line) => logged.push(line)
		})
	);
}

function spec(text: string): GitSourceSpec {
	return value(parseGitSourceSpec(text));
}

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

function failure<T>(result: Result<T, ReportError>): ReportError {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

function created(outcome: OpenOutcome): ReportId {
	if (outcome.kind !== 'created') throw new Error(`expected a new report, got ${outcome.kind}`);
	return outcome.report.id;
}

async function snapshotCount(data: AbsolutePath): Promise<number> {
	let count = 0;
	for (const store of value(await listStores(data)))
		count += value(await listSnapshots(store)).length;
	return count;
}

/** Each file's runs as "path: side first..last bucket role", for comparing loads. */
function describeState(page: LoadedReport): readonly string[] {
	return page.diff.files.flatMap((file) =>
		assignedUnits(page.state, file).map((u) => {
			const where =
				u.kind === 'lines'
					? `${u.range.side} ${String(u.range.first)}..${String(u.range.last)}`
					: 'file';
			const bucket = u.assignment.bucket;
			const name = bucket.kind === 'section' ? bucket.section : bucket.kind;
			return `${escapedRepoPath(file.file.path)}: ${where} ${name} ${u.assignment.role}`;
		})
	);
}

describe('the report service', () => {
	it('opens uncommitted changes as a new report, sorting out the lockfile, and resumes it the next time', async () => {
		const { repo, service } = await setUp();
		const opened = value(await service.open(repo.dir, spec('working-tree')));
		expect(opened).toMatchObject({
			kind: 'created',
			report: {
				id: 'r_1',
				title: 'Uncommitted changes',
				state: { kind: 'open' },
				revision: 1,
				size: { files: 3, addedLines: 4, deletedLines: 1 },
				progress: { counted: 4, reviewed: 0, ignored: 1, uncategorised: 4 },
				leftOut: 0,
				createdAt: 1_700_000_000_000
			},
			autoIgnored: [{ path: 'package-lock.json', by: { kind: 'rule', rule: 'lockfile' }, units: 1 }]
		});
		const page = value(await service.load(created(opened)));
		expect(page.revision.snapshot).toBe('00000000000000000000000000000001');
		const again = value(await service.open(repo.dir, spec('uncommitted')));
		expect(again).toMatchObject({ kind: 'resumed', update: undefined, report: { id: 'r_1' } });
		const list = value(service.list());
		expect(list.map((r) => r.id)).toEqual(['r_1']);
		service.close();
	});

	it('makes one report and keeps one snapshot when a source is opened several times at once', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const other = await serviceOn(data, clock, who, 'b');
		const outcomes = await Promise.all([
			service.open(repo.dir, spec('working-tree')),
			service.open(repo.dir, spec('working-tree')),
			service.open(repo.dir, spec('working-tree')),
			other.open(repo.dir, spec('working-tree')),
			other.open(repo.dir, spec('working-tree'))
		]);
		const reports = new Set(
			outcomes
				.map((o) => value(o))
				.map((o) => (o.kind === 'nothing-to-review' ? undefined : o.report.id))
		);
		expect(reports.size).toBe(1);
		expect(outcomes.filter((o) => value(o).kind === 'created')).toHaveLength(1);
		expect(value(service.list())).toHaveLength(1);
		expect(value(other.list())).toHaveLength(1);
		expect(await snapshotCount(data)).toBe(1);
		const [id] = [...reports];
		if (id === undefined) throw new Error('no report');
		expect(value(await other.load(id)).diff.files).toHaveLength(3);
		other.close();
		service.close();
	});

	it('says there is nothing to review, and keeps no report or snapshot, when a source has no changes', async () => {
		const { repo, data, service } = await setUp();
		await repo.commit('everything');
		const outcome = value(await service.open(repo.dir, spec('working-tree')));
		expect(outcome).toMatchObject({
			kind: 'nothing-to-review',
			source: 'Uncommitted changes',
			closed: undefined
		});
		if (outcome.kind === 'nothing-to-review')
			expect(outcome.reason).toMatch(/no uncommitted changes/);
		expect(value(service.list())).toEqual([]);
		expect(await snapshotCount(data)).toBe(0);
		service.close();
	});

	it('loads a report from the database and the store alone, even once the repository is gone', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		value(
			await service.upsertSections(id, FIRST, [
				{ id: 'app', title: 'The app', summary: 'What it *does*' }
			])
		);
		value(await service.assign(id, FIRST, [{ file: 'src/app.ts', lines: '+2', section: 'app' }]));
		value(await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true));
		service.close();
		await rm(repo.dir, { recursive: true, force: true });

		const later = await serviceOn(data, clock, who, 'b');
		const page = value(await later.load(id));
		later.close();
		expect(page.diff.files.map((f) => f.file.path)).toEqual([
			'package-lock.json',
			'src/app.test.ts',
			'src/app.ts'
		]);
		expect(page.sections).toEqual([{ id: 'app', title: 'The app', summary: 'What it *does*' }]);
		expect(describeState(page)).toEqual([
			'package-lock.json: new 1..1 ignored code',
			'src/app.test.ts: new 1..1 uncategorised test',
			'src/app.ts: old 2..2 uncategorised code',
			'src/app.ts: new 2..2 app code',
			'src/app.ts: new 4..4 uncategorised code'
		]);
		expect(page.progress.overall).toEqual({
			units: 4,
			reviewedUnits: 3,
			slices: 3,
			reviewedSlices: 2
		});
		expect(page.summary.progress).toEqual({
			counted: 4,
			reviewed: 3,
			ignored: 1,
			uncategorised: 3
		});
		expect(page.revision.number).toBe(1);
		expect(page.revision.baseCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(page.revision.headCommit).toBeUndefined();
	});

	it('applies sections, assign items and ticks, each saved as it happens', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		clock.advance(1_000);
		const sections = value(
			await service.upsertSections(
				id,
				FIRST,
				[
					{ id: 'tests', title: 'Tests' },
					{ id: 'app', title: 'The app' }
				],
				['app', 'tests']
			)
		);
		expect(sections.map((s) => s.id)).toEqual(['app', 'tests']);

		const outcome = value(
			await service.assign(id, FIRST, [
				{ file: 'src/app.ts', section: 'app' },
				{ glob: '**/*.test.ts', section: 'tests' },
				{ file: 'src/app.ts', section: 'nowhere' }
			])
		);
		expect(outcome.accepted.map((a) => a.units)).toEqual([3, 1]);
		expect(outcome.rejected.map((r) => r.rejection.kind)).toEqual(['UnknownSection']);
		expect(outcome.uncategorised).toBe(0);

		const app = value(parseSectionId('app'));
		const ticked = value(
			await service.markReviewed(
				id,
				FIRST,
				{ kind: 'slice', group: { kind: 'section', section: app }, path: path('src/app.ts') },
				true
			)
		);
		expect(ticked.units).toBe(3);
		expect(ticked.progress.overall).toEqual({
			units: 4,
			reviewedUnits: 3,
			slices: 2,
			reviewedSlices: 1
		});
		service.close();

		const later = await serviceOn(data, clock, who, 'b');
		const [summary] = value(later.list());
		const page = value(await later.load(id));
		later.close();
		expect(summary).toMatchObject({
			lastActivityAt: 1_700_000_001_000,
			progress: { counted: 4, reviewed: 3, ignored: 1, uncategorised: 0 }
		});
		expect(page.state.files.get(path('src/app.ts'))).toMatchObject({ file: undefined });
		expect(describeState(page)).toContain('src/app.ts: new 4..4 app code');
		expect(
			[...page.progress.groups.values()].map((g) => [g.key.kind, g.tally.reviewedSlices])
		).toEqual([
			['section', 1],
			['section', 0],
			['ignored', 0]
		]);
		expect([...page.progress.groups.values()].map((g) => g.key)).toEqual([
			{ kind: 'section', section: 'app' },
			{ kind: 'section', section: 'tests' },
			{ kind: 'ignored' }
		]);
		expect([...ticked.progress.groups.values()].map((g) => g.key.kind)).toEqual([
			'section',
			'section',
			'ignored'
		]);
	});

	it('changes nothing when a change is refused', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const before = value(await service.load(id));

		const sections = failure(await service.upsertSections(id, FIRST, [{ id: 'app' }]));
		expect(sections.kind).toBe('SectionsRefused');
		expect(describeReportError(sections)).toMatch(/app is a new section, so it needs a title/);
		const empty = failure(
			await service.markReviewed(id, FIRST, { kind: 'file', path: path('README.md') }, true)
		);
		expect(empty.kind).toBe('FileNotInDiff');
		const rejected = value(
			await service.assign(id, FIRST, [{ file: 'src/app.ts', section: 'nowhere' }])
		);
		expect(rejected.accepted).toEqual([]);

		value(service.closeReport(id));
		expect(
			failure(
				await service.assign(id, FIRST, [{ file: 'src/app.ts', section: 'ignored', reason: 'x' }])
			).kind
		).toBe('ReportClosed');
		expect(
			failure(
				await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true)
			).kind
		).toBe('ReportClosed');
		const after = value(await service.load(id));
		service.close();
		expect(describeState(after)).toEqual(describeState(before));
		expect(after.sections).toEqual([]);
		expect(after.reviewed.files.size).toBe(0);
		expect(after.summary.state).toEqual({ kind: 'closed', reason: 'reviewer' });
	});

	it('refuses to load a report whose stored rows no longer fit its diff', async () => {
		const { repo, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const db = value(await Database.open(data, clock));
		value(
			db.write((q) => {
				q.run("INSERT INTO reviewed_marks VALUES ('v_1', CAST('gone.ts' AS BLOB), 'file', 0, 0)");
				return ok(undefined);
			})
		);
		db.close();
		const error = failure(await service.load(id));
		expect(error).toMatchObject({
			kind: 'StoredStateMismatch',
			what: 'reviewed marks',
			path: 'gone.ts'
		});
		expect(describeReportError(error)).toMatch(
			/Delete the Delve from the list of Delves and open its changes again/
		);
		const ticked = failure(
			await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true)
		);
		expect(ticked.kind).toBe('StoredStateMismatch');
		service.close();
	});

	it('refuses a tick, not saying the database is busy, when the diff is updated while it is saved', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		// Another copy of diff delver keeps adding revisions while this one saves a tick.
		const other = new DatabaseSync(join(data, DATABASE_FILE));
		const call = { settled: false };
		const marking = service
			.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true)
			.finally(() => {
				call.settled = true;
			});
		for (let n = 2; !call.settled; n += 1) {
			other
				.prepare(
					`INSERT INTO revisions SELECT ?, report_id, ?, store_id, snapshot_id, base_tree, head_tree, fingerprint, base_commit, head_commit, left_out, taken_at, file_count, added_lines, deleted_lines, counted_units, reviewed_units, ignored_units, uncategorised_units FROM revisions WHERE id = 'v_1'`
				)
				.run(`v_other${String(n)}`, n);
			await new Promise((resolve) => setImmediate(resolve));
		}
		other.close();
		const error = failure(await marking);
		// It was made on version 1, so it is not made on a newer one.
		expect(error).toMatchObject({ kind: 'VersionOutOfDate', report: id, seen: 1 });
		expect(describeReportError(error)).toMatch(
			/^This Delve was updated to version \d+ after you last looked at it, so nothing was changed: what you did was meant for version 1\. Show the new version first/
		);
		const raw = new DatabaseSync(join(data, DATABASE_FILE), { readOnly: true });
		expect(raw.prepare('SELECT COUNT(*) AS n FROM reviewed_marks').get()).toEqual({ n: 0 });
		raw.close();
		service.close();
	});

	it('refuses a change meant for a version the diff never had, saying so truly', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const second = value(parseRevisionNumber(2));
		const app = { kind: 'file', path: path('src/app.ts') } as const;
		const errors = [
			failure(await service.markReviewed(id, second, app, true)),
			failure(await service.assign(id, second, [{ file: 'src/app.ts', section: 'app' }])),
			failure(await service.upsertSections(id, second, [{ id: 'app', title: 'App' }]))
		];
		for (const error of errors) {
			expect(error).toEqual({ kind: 'VersionNotFound', report: id, seen: 2, current: 1 });
			expect(describeReportError(error)).toBe(
				'This Delve has no version 2: its newest is version 1, so nothing was changed. Reload the page to see the current version, then do it again there.'
			);
		}
		const raw = new DatabaseSync(join(data, DATABASE_FILE), { readOnly: true });
		expect(raw.prepare('SELECT COUNT(*) AS n FROM reviewed_marks').get()).toEqual({ n: 0 });
		expect(raw.prepare('SELECT COUNT(*) AS n FROM sections').get()).toEqual({ n: 0 });
		raw.close();
		service.close();
	});

	it('notices a change, ignores a false alarm, and says when nothing is left without closing the report', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });

		// Staging moves the changes into the index; the working tree, and so the snapshot, is the same.
		await repo.git('add', '--all');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });

		await repo.write('src/app.ts', 'changed again\n');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'changed', files: 1 });
		// Opening it again is a request to see the files as they are now: it updates.
		expect(value(await service.open(repo.dir, spec('working-tree')))).toMatchObject({
			kind: 'resumed',
			report: { revision: 2 },
			update: { filesChanged: 1 }
		});
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });

		const committed = await repo.commit('Add the fourth line');
		const check = value(await service.checkForChanges(id));
		if (check.kind !== 'nothing-left') throw new Error(check.kind);
		expect(check.reason).toMatch(
			/have most likely been committed, in commit [0-9a-f]{7}, “Add the fourth line”. What you were reading is still shown/
		);
		expect(check.next).toEqual({
			spec: { kind: 'commit', revision: committed.commit },
			offer: `Review commit ${committed.commit.slice(0, 7)}, “Add the fourth line”`
		});
		// Asking again gives the same answer, and the report is still open and readable.
		expect(value(await service.checkForChanges(id))).toEqual(check);
		expect(value(service.list())[0]).toMatchObject({ kind: 'report', state: { kind: 'open' } });
		expect(value(await service.load(id)).diff.files).toHaveLength(3);
		const current = value(await service.load(id)).revision.number;
		value(await service.upsertSections(id, current, [{ id: 'app', title: 'App' }]));

		// Opening the source again, with nothing to review, closes it and says where the changes went.
		const reopened = value(await service.open(repo.dir, spec('working-tree')));
		expect(reopened).toMatchObject({
			kind: 'nothing-to-review',
			closed: id,
			next: { spec: { kind: 'commit', revision: committed.commit } }
		});
		expect(value(service.list())[0]).toMatchObject({
			kind: 'report',
			state: { kind: 'closed', reason: 'source-empty' }
		});
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'report-closed' });

		// The next day's work in the same worktree is a new report; the old one stays readable.
		await repo.write('README.md', '# App, again\n');
		const next = value(await service.open(repo.dir, spec('working-tree')));
		expect(next).toMatchObject({ kind: 'created', report: { id: 'r_2' } });
		expect(value(await service.load(id)).summary.state.kind).toBe('closed');
		service.close();
	});

	it('closes a resumed report whose source has become empty, and says so', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.commit('done');
		const outcome = value(await service.open(repo.dir, spec('working-tree')));
		expect(outcome).toMatchObject({ kind: 'nothing-to-review', closed: id });
		service.close();
	});

	it('offers the commits made since when the changes went into several', async () => {
		const { repo, service } = await setUp();
		await repo.git('add', '--all');
		const id = created(value(await service.open(repo.dir, spec('staged'))));
		const base = value(await service.load(id)).revision.baseCommit;
		await repo.git('commit', '--quiet', '-m', 'The app', '--', 'src/app.ts');
		const last = await repo.commit('The rest');
		const check = value(await service.checkForChanges(id));
		if (check.kind !== 'nothing-left' || base === undefined) throw new Error(check.kind);
		expect(check.reason).toMatch(
			/staged changes have most likely been committed, in the commits made since/
		);
		expect(check.next).toEqual({
			spec: { kind: 'range', from: base, to: last.commit },
			offer: `Review the commits made since, ${base.slice(0, 7)} to ${last.commit.slice(0, 7)}`
		});
		service.close();
	});

	it('offers nothing, and says so, when the changes were discarded or it cannot be told where they went', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.git('stash', '--include-untracked', '--quiet');
		const discarded = value(await service.checkForChanges(id));
		if (discarded.kind !== 'nothing-left') throw new Error(discarded.kind);
		expect(discarded.reason).toMatch(
			/nothing has been committed, so they were most likely discarded/
		);
		expect(discarded.next).toBeUndefined();

		// A branch with no history in common: where the changes went cannot be told.
		await repo.git('checkout', '--quiet', '--orphan', 'elsewhere');
		await repo.commit('Elsewhere');
		const unknown = value(await service.checkForChanges(id));
		if (unknown.kind !== 'nothing-left') throw new Error(unknown.kind);
		expect(unknown.reason).toMatch(/may have been committed, merged or discarded/);
		expect(unknown.next).toBeUndefined();
		expect(value(await service.open(repo.dir, spec('working-tree')))).toMatchObject({
			kind: 'nothing-to-review',
			closed: id,
			next: undefined
		});
		service.close();
	});

	it('closes, reopens and deletes reports, freeing their snapshots', async () => {
		const { repo, data, service } = await setUp();
		const first = created(value(await service.open(repo.dir, spec('working-tree'))));
		value(service.closeReport(first));
		const second = created(value(await service.open(repo.dir, spec('working-tree'))));
		const refused = failure(service.reopenReport(first));
		expect(refused).toEqual({ kind: 'AnotherReportOpen', report: first, open: second });
		expect(describeReportError(refused)).toMatch(/cannot be reopened while another Delve/);

		value(service.closeReport(second));
		expect(value(service.reopenReport(first)).state).toEqual({ kind: 'open' });
		expect(await snapshotCount(data)).toBe(2);

		const deleted = value(await service.deleteReport(second));
		expect(deleted).toEqual({ snapshots: 1, storeProblem: undefined });
		expect(value(service.list()).map((r) => r.id)).toEqual([first]);
		expect(await snapshotCount(data)).toBe(1);
		expect(failure(await service.load(second)).kind).toBe('ReportNotFound');
		expect(failure(await service.deleteReport(second)).kind).toBe('ReportNotFound');
		service.close();
	});

	it.each([
		[
			"the report's row",
			"UPDATE reports SET repository_name = '' WHERE id = 'r_1'",
			'(a Delve’s details)',
			'"table":"reports"'
		],
		[
			'a revision row',
			"UPDATE revisions SET left_out = 'not JSON' WHERE id = 'v_1'",
			'(a saved version of a Delve)',
			'left_out'
		],
		[
			'its revisions are gone, so it',
			"DELETE FROM revisions WHERE id = 'v_1'",
			'no saved version',
			'ReportHasNoRevision'
		]
	])(
		'lists a report as damaged when %s cannot be read, beside the others, and deletes it',
		async (_what, damage, problem, logDetail) => {
			const { repo, data, clock, service, logged } = await setUp();
			const damaged = created(value(await service.open(repo.dir, spec('working-tree'))));
			clock.advance(1_000);
			const good = created(value(await service.open(repo.dir, spec('HEAD'))));
			expect(await snapshotCount(data)).toBe(2);
			const db = value(await Database.open(data, clock));
			value(
				db.write((q) => {
					q.exec('PRAGMA foreign_keys = OFF');
					q.run(damage);
					return ok(undefined);
				})
			);
			db.close();

			const listed = value(service.list());
			expect(listed.map((r) => [r.kind, r.id])).toEqual([
				['report', good],
				['damaged', damaged]
			]);
			const entry = listed[1];
			if (entry?.kind !== 'damaged') throw new Error('expected a damaged entry');
			expect(entry.problem).toContain(problem);
			expect(entry.problem).toMatch(/Delete/);
			// In the reviewer's words: no table or column names. Those go to the log, once.
			expect(entry.problem).not.toMatch(/table|reports|revisions|column|_/);
			expect(logged).toHaveLength(1);
			expect(logged[0]).toContain(logDetail);
			value(service.list());
			expect(logged).toHaveLength(1);
			expect(value(await service.load(good)).summary.id).toBe(good);

			expect(value(await service.deleteReport(damaged)).storeProblem).toBeUndefined();
			expect(value(service.list()).map((r) => [r.kind, r.id])).toEqual([['report', good]]);
			expect(failure(await service.load(damaged)).kind).toBe('ReportNotFound');
			expect(await snapshotCount(data)).toBe(problem === 'no saved version' ? 2 : 1);
			service.close();
		}
	);

	it('starts a new report in place of one whose saved snapshot is gone, and closes the old one saying why', async () => {
		const { repo, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await rm(join(data, 'stores'), { recursive: true, force: true });
		clock.advance(1_000);

		const gone = failure(await service.load(id));
		expect(gone).toEqual({
			kind: 'SnapshotGone',
			report: id,
			source: 'Uncommitted changes',
			open: true
		});
		expect(describeReportError(gone)).toMatch(
			/is gone from diff delver's data folder.*Open Uncommitted changes again to start a new Delve/
		);
		expect(
			failure(
				await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true)
			).kind
		).toBe('SnapshotGone');
		expect(failure(await service.assign(id, FIRST, [])).kind).toBe('SnapshotGone');

		const again = value(await service.open(repo.dir, spec('working-tree')));
		expect(again).toMatchObject({ kind: 'created', report: { id: 'r_2' }, closed: id });
		const listed = value(service.list());
		expect(listed.map((r) => (r.kind === 'report' ? [r.id, r.state] : [r.id]))).toEqual([
			['r_2', { kind: 'open' }],
			[id, { kind: 'closed', reason: 'snapshot-gone' }]
		]);
		expect(describeClosedReason('snapshot-gone')).toMatch(/saved copy of its changes was gone/);
		expect(value(await service.load(value(parseReportId('r_2')))).diff.files).toHaveLength(3);
		const closed = failure(await service.load(id));
		expect(closed).toMatchObject({ kind: 'SnapshotGone', open: false });
		expect(describeReportError(closed)).toMatch(/Delete it/);
		expect(describeReportError(closed)).not.toMatch(/Open Uncommitted changes again/);
		service.close();
	});

	it('deletes a report whose saved copy is already gone without calling that a problem', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await rm(join(data, 'stores'), { recursive: true, force: true });
		expect(value(await service.deleteReport(id))).toEqual({
			snapshots: 0,
			storeProblem: undefined
		});
		service.close();
	});

	it('says a report was deleted, and its space is freed later, when its snapshot cannot be removed yet', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const [store] = value(await listStores(data));
		if (store === undefined) throw new Error('no store');
		// git cannot take the lock it needs to delete the snapshot's ref.
		await chmod(store.dir, 0o555);
		try {
			const deleted = value(await service.deleteReport(id));
			expect(deleted.storeProblem).toMatch(
				/^The Delve was deleted, but the space its saved changes use could not be freed yet.*frees it by itself later/
			);
			expect(deleted.storeProblem).not.toMatch(/Open the/);
		} finally {
			await chmod(store.dir, 0o755);
		}
		expect(failure(await service.load(id)).kind).toBe('ReportNotFound');
		service.close();
	});

	it('names no internal ids in what it tells the reviewer about another open report or a missing revision', async () => {
		const { repo, service } = await setUp();
		const first = created(value(await service.open(repo.dir, spec('working-tree'))));
		value(service.closeReport(first));
		const second = created(value(await service.open(repo.dir, spec('working-tree'))));
		const refused = describeReportError(failure(service.reopenReport(first)));
		expect(refused).not.toContain(second);
		expect(describeReportError({ kind: 'ReportHasNoRevision', report: first })).not.toContain(
			first
		);
		service.close();
	});

	it('removes a snapshot nothing refers to once the grace period has passed', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		// A snapshot taken by a run that crashed before recording its revision.
		value(
			await snapshotGitSource(
				data,
				await located(repo.dir, who),
				spec('HEAD'),
				randomIds.snapshotId()
			)
		);
		expect(await snapshotCount(data)).toBe(2);

		expect(value(await service.removeUnusedSnapshots())).toEqual([]);
		clock.advance(GRACE_PERIOD);
		expect(value(await service.removeUnusedSnapshots())).toEqual([]);
		clock.advance(1);
		expect(value(await service.removeUnusedSnapshots())).toHaveLength(1);
		expect(await snapshotCount(data)).toBe(1);
		expect(value(await service.load(id)).summary.id).toBe(id);
		service.close();
	});

	it('stores paths that are not UTF-8 exactly, and takes them in their escaped form', async () => {
		const repo = await useFixture(oddPathBytes);
		const who = await reviewer();
		const service = await serviceOn(await tempDirectory(), settableClock(at(0)), who);
		const id = created(value(await service.open(repo.dir, spec('HEAD'))));
		value(await service.upsertSections(id, FIRST, [{ id: 'odd', title: 'Odd names' }]));
		const outcome = value(
			await service.assign(id, FIRST, [{ file: 'caf\\xE9.txt', section: 'odd' }])
		);
		expect(outcome.accepted.map((a) => a.units)).toEqual([1]);
		const page = value(await service.load(id));
		service.close();
		expect(page.diff.files.map((f) => escapedRepoPath(f.file.path)).sort()).toEqual([
			'caf\\\\xE9.txt',
			'caf\\xE8.txt',
			'caf\\xE9.txt',
			'dir\\xFF/inner.txt'
		]);
		expect(describeState(page).filter((line) => line.includes(' odd '))).toEqual([
			'caf\\xE9.txt: new 2..2 odd code'
		]);
	});

	it('writes nothing to the reviewed repository, whatever it is asked to do', async () => {
		const { repo, clock, service } = await setUp();
		const { before, after } = await listingsAround([repo.dir], async () => {
			const id = created(value(await service.open(repo.dir, spec('working-tree'))));
			value(await service.open(repo.dir, spec('main...HEAD')));
			value(await service.load(id));
			value(service.list());
			value(await service.upsertSections(id, FIRST, [{ id: 'app', title: 'App' }]));
			value(await service.assign(id, FIRST, [{ file: 'src/app.ts', section: 'app' }]));
			value(
				await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true)
			);
			value(await service.checkForChanges(id));
			value(service.closeReport(id));
			value(service.reopenReport(id));
			value(await service.deleteReport(id));
			clock.advance(GRACE_PERIOD + 1);
			value(await service.removeUnusedSnapshots());
		});
		service.close();
		expect(after).toEqual(before);
	});

	it('writes nothing to the reviewed repository when what it is asked to do fails', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const { before, after } = await listingsAround([repo.dir], async () => {
			expect(failure(await service.open(repo.dir, spec('no-such-branch'))).kind).toBe(
				'UnknownRevision'
			);
			expect(failure(await service.open(repo.dir, spec('main...no-such-branch'))).kind).toBe(
				'UnknownRevision'
			);
			expect(failure(await service.upsertSections(id, FIRST, [{ id: 'app' }])).kind).toBe(
				'SectionsRefused'
			);
			const refused = value(
				await service.assign(id, FIRST, [{ file: 'nope.ts', section: 'nowhere' }])
			);
			expect(refused.accepted).toEqual([]);
			expect(
				failure(
					await service.markReviewed(id, FIRST, { kind: 'file', path: path('nope.ts') }, true)
				).kind
			).toBe('FileNotInDiff');
			expect(failure(await service.load(value(parseReportId('r_404')))).kind).toBe(
				'ReportNotFound'
			);
			value(service.closeReport(id));
			expect(failure(await service.assign(id, FIRST, [])).kind).toBe('ReportClosed');
			const second = created(value(await service.open(repo.dir, spec('working-tree'))));
			expect(failure(service.reopenReport(id)).kind).toBe('AnotherReportOpen');
			expect(value(await service.checkForChanges(id))).toEqual({ kind: 'report-closed' });
			expect(failure(await service.deleteReport(value(parseReportId('r_404')))).kind).toBe(
				'ReportNotFound'
			);
			value(await service.deleteReport(second));
		});
		service.close();
		expect(after).toEqual(before);
	});

	it('starts with no arguments on the uncommitted changes, or says why there is nothing', async () => {
		const { repo, service } = await setUp();
		const started = value(await service.start(repo.dir));
		expect(started).toMatchObject({
			kind: 'opened',
			opened: { kind: 'created', report: { title: 'Uncommitted changes' } }
		});
		await repo.commit('done');
		const clean = value(await service.start(repo.dir));
		expect(clean.kind).not.toBe('opened');
		service.close();
	});

	it('explains every failure in words the reviewer can act on', async () => {
		const { service } = await setUp();
		const missing = failure(await service.open(await tempDirectory(), spec('working-tree')));
		expect(missing.kind).toBe('NotARepository');
		expect(describeReportError(missing).length).toBeGreaterThan(20);
		const unknown = failure(await service.load(value(parseReportId('r_404'))));
		expect(describeReportError(unknown)).toMatch(/This Delve is not in diff delver any more/);
		service.close();
	});

	it('checks whether a source can be opened and has changes cheaply, writing nothing', async () => {
		const { repo, data, service } = await setUp();
		await repo.git('branch', 'feature');
		const check = (text: string) => service.checkSource(repo.dir, spec(text));
		// Nothing has been opened, so the data folder has no store; checking makes none.
		const { before, after, result } = await listingsAround([data, repo.dir], async () => ({
			workingTree: await check('working-tree'),
			staged: await check('staged'),
			head: await check('HEAD'),
			range: await check('main...feature'),
			unknown: await check('no-such-branch'),
			unknownRange: await check('no-such-branch...feature')
		}));
		expect(after).toEqual(before);
		expect(value(result.workingTree)).toBe('changes');
		expect(value(result.staged)).toBe('nothing');
		expect(value(result.head)).toBe('changes');
		expect(value(result.range)).toBe('nothing');
		expect(failure(result.unknown).kind).toBe('UnknownRevision');
		expect(failure(result.unknownRange).kind).toBe('UnknownRevision');
		await repo.git('add', 'src/app.ts');
		expect(value(await check('staged'))).toBe('changes');
		service.close();
	});

	it('never removes the snapshot a check keeps for the next update, however long it waits', async () => {
		const { repo, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/app.ts', 'one\n2\nthree\nfour\nfive\n');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'changed', files: 1 });
		// No version refers to it, and it has waited past the grace period: it is still kept.
		value(await service.tidyStores());
		clock.advance(GRACE_PERIOD);
		clock.advance(1);
		expect(value(await service.removeUnusedSnapshots())).toEqual([]);
		value(await service.tidyStores());
		expect(await snapshotCount(data)).toBe(2);
		// The update uses it while a tidy runs beside it, and the new version can be read.
		const [updated] = await Promise.all([service.update(id), service.tidyStores()]);
		expect(value(updated).kind).toBe('updated');
		const page = value(await service.load(id));
		expect(page.revision.snapshot).toBe('00000000000000000000000000000002');
		clock.advance(GRACE_PERIOD);
		clock.advance(1);
		value(await service.tidyStores());
		expect(value(await service.load(id)).revision.snapshot).toBe(page.revision.snapshot);
		service.close();
	});

	it('takes a fresh snapshot for an update when the one a check kept has gone', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/app.ts', 'one\n2\nthree\nfour\nfive\n');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'changed', files: 1 });
		const [store] = value(await listStores(data));
		if (store === undefined) throw new Error('no store');
		const kept = value(await listSnapshots(store)).find(
			(s) => s.id === '00000000000000000000000000000002'
		);
		if (kept === undefined) throw new Error('the check kept no snapshot');
		value(await deleteSnapshot(store, kept.id));
		expect(value(await service.update(id)).kind).toBe('updated');
		const page = value(await service.load(id));
		expect(page.revision.snapshot).toBe('00000000000000000000000000000003');
		expect(page.diff.files.length).toBeGreaterThan(0);
		service.close();
	});

	it('collects a store when it tidies after a check discarded a snapshot from it', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		expect(value(await service.tidyStores())).toEqual([]);
		// A false alarm: the file is written again as it was, so the check's snapshot is not kept.
		await repo.write('src/app.ts', 'one\n2\nthree\nfour\n');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		const page = value(await service.load(id));
		expect(value(await service.tidyStores())).toEqual([page.revision.store]);
		expect(value(await service.tidyStores())).toEqual([]);
		service.close();
	});
});
