/**
 * Bringing a diff up to date (DESIGN 6.2) through the real service, with real
 * repositories: what is kept, what is new, and that nothing is half done.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import { fileAssignment, sideMap } from '#lib/core/diff/state.ts';
import { fileUnitInSet, linesInSet } from '#lib/core/diff/unit-set.ts';
import { sequentialIds, type IdSource } from '#lib/core/ids.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { Side } from '#lib/core/side.tiny.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { listSnapshots, listStores } from '#lib/server/store/index.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import type { GitRepo } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { DATABASE_FILE } from '../db/index.ts';
import { describeUpdate } from '#lib/core/update/update-summary.ts';
import {
	describeReportError,
	ReportService,
	type LoadedReport,
	type OpenOutcome
} from './index.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';

/** The first version of a diff, which changes are made on until it is updated. */
const FIRST = value(parseRevisionNumber(1));

const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;
const numbered = (count: number): readonly string[] =>
	Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`);

function spec(text: string): GitSourceSpec {
	return value(parseGitSourceSpec(text));
}

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

function created(outcome: OpenOutcome): ReportId {
	if (outcome.kind !== 'created') throw new Error(`expected a new report, got ${outcome.kind}`);
	return outcome.report.id;
}

async function serviceFor(data: AbsolutePath): Promise<ReportService> {
	const who = await reviewer();
	return value(
		await ReportService.open({
			dataDirectory: data,
			clock: settableClock(at(1_700_000_000_000)),
			ids: sequentialIds(),
			repository: { gitEnv: who.gitEnv }
		})
	);
}

interface Setup {
	readonly repo: GitRepo;
	readonly data: AbsolutePath;
	readonly service: ReportService;
}

/** A committed app.ts of 20 lines, edited in the working tree, a new file and a lockfile. */
async function setUp(): Promise<Setup> {
	const repo = await emptyRepo();
	await repo.write('src/app.ts', lines(...numbered(20)));
	await repo.write('README.md', '# App\n');
	await repo.commit('first');
	await repo.write('src/app.ts', lines(...edited(numbered(20))));
	await repo.write('src/new.ts', lines('new 1', 'new 2', 'new 3'));
	await repo.write('package-lock.json', '{}\n');
	const data = await tempDirectory();
	return { repo, data, service: await serviceFor(data) };
}

/** Line 10 changed and a line added after line 5. */
function edited(base: readonly string[]): readonly string[] {
	return [
		...base.slice(0, 5),
		'added after 5',
		...base.slice(5, 9),
		'changed 10',
		...base.slice(10)
	];
}

async function snapshotCount(data: AbsolutePath): Promise<number> {
	let count = 0;
	for (const store of value(await listStores(data)))
		count += value(await listSnapshots(store)).length;
	return count;
}

/** Every row of every table, to prove an operation changed nothing. */
function everyRow(data: AbsolutePath): Record<string, unknown> {
	const raw = new DatabaseSync(join(data, DATABASE_FILE), { readOnly: true });
	try {
		const tables = raw
			.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
			.all()
			.map((t) => String(t.name));
		return Object.fromEntries(
			tables.map((name) => [
				name,
				raw
					.prepare(`SELECT * FROM "${name}"`)
					.all()
					.map((r) => ({ ...r }))
			])
		);
	} finally {
		raw.close();
	}
}

function marked(page: LoadedReport, file: string, side: Side): readonly number[] {
	return [...linesInSet(page.reviewed, path(file), side).values()];
}

function fresh(page: LoadedReport, file: string, side: Side): readonly number[] {
	return [...linesInSet(page.fresh, path(file), side).values()];
}

function bucket(page: LoadedReport, file: string, side: Side, line: number): string {
	const f = page.diff.byPath.get(path(file));
	if (f === undefined) throw new Error(file);
	const b = sideMap(fileAssignment(page.state, f), side).get(line)?.bucket;
	switch (b?.kind) {
		case 'section':
			return b.section;
		case 'ignored':
			return b.by.kind === 'agent' ? `ignored: ${b.by.reason}` : `ignored by ${b.by.kind}`;
		case 'uncategorised':
			return 'not sorted';
		case undefined:
			return 'none';
	}
}

/** Sorts r_1: app.ts in a section, a line of new.ts ignored by the agent; and marks app.ts and new.ts. */
async function sortAndMark(service: ReportService, id: ReportId): Promise<void> {
	value(await service.upsertSections(id, FIRST, [{ id: 'app', title: 'The app' }]));
	value(await service.upsertSections(id, FIRST, [{ id: 'empty', title: 'Nothing left in here' }]));
	const assigned = value(
		await service.assign(id, FIRST, [
			{ file: 'src/app.ts', section: 'app' },
			{ file: 'src/new.ts', lines: '+1', section: 'ignored', reason: 'Generated' },
			{ file: 'src/new.ts', lines: '+2', section: 'empty' }
		])
	);
	expect(assigned.rejected).toEqual([]);
	value(await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true));
	value(await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/new.ts') }, true));
}

describe('updating a diff', () => {
	it('keeps sections, sorting and ticks on unchanged lines, and gives new lines as new', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await sortAndMark(service, id);
		const first = value(await service.load(id));
		expect(marked(first, 'src/app.ts', 'new')).toEqual([6, 11]);

		// A line written at the top moves everything down; one more is added at the end,
		// and new.ts loses the line that was in "empty".
		await repo.write('src/app.ts', lines('top', ...edited(numbered(20)), 'at the end'));
		await repo.write('src/new.ts', lines('new 1', 'new 3'));
		const { before, after, result } = await listingsAround([repo.dir], () => service.update(id));
		expect(after).toEqual(before);
		const updated = value(result);
		if (updated.kind !== 'updated') throw new Error(updated.kind);
		expect(updated.report.revision).toBe(2);
		expect(updated.summary).toEqual({
			filesChanged: 2,
			filesGone: 0,
			newToReview: 2,
			newIgnored: 0,
			gone: 1,
			reviewedBefore: 6,
			// new.ts lost its middle line, so the two lines beside the gap need another look.
			reviewedKept: 3
		});

		const page = value(await service.load(id));
		expect(page.revision.number).toBe(2);
		expect(page.update).toEqual({
			revision: 2,
			at: page.revision.takenAt,
			summary: updated.summary
		});
		// Every section is kept, with its title and place, even the one that is empty now.
		expect(page.sections.map((s) => [s.id, s.title])).toEqual([
			['app', 'The app'],
			['empty', 'Nothing left in here']
		]);
		// The reviewed lines moved down one; the new ones are new, not sorted and not reviewed.
		expect(marked(page, 'src/app.ts', 'new')).toEqual([7, 12]);
		expect(marked(page, 'src/app.ts', 'old')).toEqual([10]);
		expect(fresh(page, 'src/app.ts', 'new')).toEqual([1, 23]);
		expect(bucket(page, 'src/app.ts', 'new', 7)).toBe('app');
		expect(bucket(page, 'src/app.ts', 'old', 10)).toBe('app');
		expect(bucket(page, 'src/app.ts', 'new', 1)).toBe('not sorted');
		expect(bucket(page, 'src/new.ts', 'new', 1)).toBe('ignored: Generated');
		expect(bucket(page, 'package-lock.json', 'new', 1)).toBe('ignored by rule');
		expect(marked(page, 'src/new.ts', 'new')).toEqual([]);
		// The two lines of new.ts beside the line it lost were unmarked, and say so.
		expect([...linesInSet(page.unmarked, path('src/new.ts'), 'new').values()]).toEqual([1, 2]);
		expect(page.unmarked.files.size).toBe(1);
		expect(page.summary.progress).toMatchObject({ reviewed: 3 });
		// The version before can still be read, as a page left open on it does; one never made cannot.
		const earlier = value(await service.load(id, FIRST));
		expect([earlier.revision.number, earlier.summary.revision]).toEqual([1, 1]);
		expect(earlier.unmarked.files.size).toBe(0);
		const never = await service.load(id, value(parseRevisionNumber(3)));
		expect(never.ok ? undefined : never.error.kind).toBe('VersionNotFound');
		// The first version and its snapshot stay; nothing else was left behind.
		expect(await snapshotCount(data)).toBe(2);
		expect(everyRow(data)['revisions']).toHaveLength(2);
		service.close();
	});

	it('keeps the overview, and moves cross-references with their lines, dropping those that changed', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await sortAndMark(service, id);
		value(service.setOverview(id, FIRST, value(parseAgentMarkdown('What *changed*'))));
		value(
			await service.upsertSections(id, FIRST, [
				{
					id: 'empty',
					references: [
						{ file: 'src/app.ts', lines: '+6,+11,-10' },
						{ file: 'src/new.ts', lines: '+3' }
					]
				}
			])
		);
		const first = value(await service.load(id));
		const refs = (page: LoadedReport, file: string, side: Side): readonly number[] => [
			...linesInSet(
				page.references.get(value(parseSectionId('empty'))) ?? { files: new Map() },
				path(file),
				side
			).values()
		];
		expect([refs(first, 'src/app.ts', 'new'), refs(first, 'src/app.ts', 'old')]).toEqual([
			[6, 11],
			[10]
		]);

		// Everything moves down one; line 11 of app.ts is edited, so its reference goes.
		const now = edited(numbered(20)).map((line, i) => (i === 10 ? 'changed 10 again' : line));
		await repo.write('src/app.ts', lines('top', ...now));
		value(await service.update(id));
		const page = value(await service.load(id));
		expect(page.overview).toBe('What *changed*');
		expect([refs(page, 'src/app.ts', 'new'), refs(page, 'src/app.ts', 'old')]).toEqual([[7], [10]]);
		expect(refs(page, 'src/new.ts', 'new')).toEqual([3]);
		// The earlier version keeps its own.
		expect(refs(value(await service.load(id, FIRST)), 'src/app.ts', 'new')).toEqual([6, 11]);
		service.close();
	});

	it('uses the snapshot the check took, instead of taking another', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/new.ts', lines('new 1', 'new 2', 'new 3', 'new 4'));
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'changed', files: 1 });
		expect(await snapshotCount(data)).toBe(2);
		const updated = value(await service.update(id));
		expect(updated.kind).toBe('updated');
		expect(await snapshotCount(data)).toBe(2);
		// The ids come in order: the first version's snapshot, then the check's.
		expect(value(await service.load(id)).revision.snapshot).toBe(
			'00000000000000000000000000000002'
		);
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		service.close();
	});

	it('makes nothing for a false alarm, says so, and deletes the snapshot it took', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		// Written again with the same text: the fingerprint changes, the files do not.
		await repo.write('src/new.ts', lines('new 1', 'new 2', 'new 3'));
		expect(value(await service.update(id))).toMatchObject({
			kind: 'unchanged',
			report: { revision: 1 }
		});
		expect(await snapshotCount(data)).toBe(1);
		service.close();
	});

	it('makes nothing when nothing is left to review, and keeps the diff open', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const committed = await repo.commit('Everything');
		const outcome = value(await service.update(id));
		expect(outcome).toMatchObject({
			kind: 'nothing-left',
			next: { spec: { kind: 'commit', revision: committed.commit } }
		});
		const page = value(await service.load(id));
		expect(page.summary.state.kind).toBe('open');
		expect(page.revision.number).toBe(1);
		service.close();
	});

	it('does not update a closed diff', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		value(service.closeReport(id));
		await repo.write('src/new.ts', 'other\n');
		const outcome = await service.update(id);
		if (outcome.ok) throw new Error('a closed diff was updated');
		expect(outcome.error).toEqual({ kind: 'ReportClosed', report: id });
		expect(describeReportError(outcome.error)).toMatch(/closed/);
		service.close();
	});

	it('follows a file renamed between the versions', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await sortAndMark(service, id);
		await repo.git('mv', 'src/app.ts', 'src/main.ts');
		const updated = value(await service.update(id));
		expect(updated).toMatchObject({
			kind: 'updated',
			// The rename itself is new to review; every line carried over.
			summary: { filesChanged: 1, newToReview: 1, gone: 0 }
		});
		const page = value(await service.load(id));
		expect(page.diff.byPath.get(path('src/main.ts'))?.file.status).toBe('renamed');
		expect(fileUnitInSet(page.fresh, path('src/main.ts'))).toBe(true);
		expect(fileUnitInSet(page.reviewed, path('src/main.ts'))).toBe(false);
		expect(marked(page, 'src/main.ts', 'new')).toEqual([6, 11]);
		expect(marked(page, 'src/main.ts', 'old')).toEqual([10]);
		expect(bucket(page, 'src/main.ts', 'new', 6)).toBe('app');
		service.close();
	});

	it('keeps ticks through a rebase that moved the base under the branch', async () => {
		const repo = await emptyRepo();
		await repo.write('src/app.ts', lines(...numbered(30)));
		await repo.commit('first');
		await repo.git('checkout', '--quiet', '-b', 'feature');
		await repo.write('src/app.ts', lines(...edited(numbered(30))));
		await repo.commit('My change');
		const data = await tempDirectory();
		const service = await serviceFor(data);
		const id = created(value(await service.open(repo.dir, spec('main...feature'))));
		value(await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true));

		// main moves on at the top of the file, and the branch is rebased onto it.
		await repo.git('checkout', '--quiet', 'main');
		await repo.write('src/app.ts', lines('upstream 1', 'upstream 2', ...numbered(30)));
		await repo.commit('Upstream');
		await repo.git('checkout', '--quiet', 'feature');
		await repo.git('rebase', '--quiet', 'main');

		const updated = value(await service.update(id));
		expect(updated).toMatchObject({
			kind: 'updated',
			summary: { filesChanged: 0, newToReview: 0, gone: 0, reviewedBefore: 3, reviewedKept: 3 }
		});
		const page = value(await service.load(id));
		expect(marked(page, 'src/app.ts', 'new')).toEqual([8, 13]);
		expect(marked(page, 'src/app.ts', 'old')).toEqual([12]);
		service.close();
	});

	it('stays whole when another call runs at the same time', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/new.ts', lines('new 1', 'new 2', 'new 3', 'new 4'));
		// A tick made on version 1 lands before the update, and is carried over, or after it,
		// and is refused: it is never made on version 2.
		const [updated, ticked, again] = await Promise.all([
			service.update(id),
			service.markReviewed(id, FIRST, { kind: 'file', path: path('src/app.ts') }, true),
			service.update(id)
		]);
		const kinds = [value(updated).kind, value(again).kind].sort();
		expect(kinds).toEqual(['unchanged', 'updated']);
		const page = value(await service.load(id));
		expect(page.revision.number).toBe(2);
		if (ticked.ok) {
			expect(ticked.value.units).toBe(3);
			expect(marked(page, 'src/app.ts', 'new')).toEqual([6, 11]);
		} else {
			expect(ticked.error).toMatchObject({ kind: 'VersionOutOfDate', seen: 1, current: 2 });
			expect(marked(page, 'src/app.ts', 'new')).toEqual([]);
		}
		// The losing update's snapshot is not left behind.
		expect(await snapshotCount(data)).toBe(2);
		service.close();
	});

	it('leaves the diff exactly as it was when the update fails midway', async () => {
		const { repo, data, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await sortAndMark(service, id);
		// A saved mark that does not fit the diff: the update reads it inside its transaction.
		const raw = new DatabaseSync(join(data, DATABASE_FILE));
		raw
			.prepare(
				"INSERT INTO reviewed_marks (revision_id, path, side, first_line, last_line) VALUES ('v_1', ?, 'new', 1, 1)"
			)
			.run(Buffer.from('not/in/the/diff.ts'));
		raw.close();
		await repo.write('src/new.ts', 'other\n');
		const rows = everyRow(data);
		const outcome = await service.update(id);
		if (outcome.ok) throw new Error('the update did not fail');
		expect(outcome.error).toMatchObject({ kind: 'StoredStateMismatch', what: 'reviewed marks' });
		expect(everyRow(data)).toEqual(rows);
		expect(await snapshotCount(data)).toBe(1);
		service.close();
	});

	it('gives a file made executable since the previous version a new change, and says so', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await sortAndMark(service, id);
		await repo.setExecutable('src/app.ts', true);
		const checked = value(await service.checkForChanges(id));
		expect(checked).toEqual({ kind: 'changed', files: 1 });
		const updated = value(await service.update(id));
		expect(updated).toMatchObject({
			kind: 'updated',
			summary: { filesChanged: 1, newToReview: 1, gone: 0, reviewedBefore: 6, reviewedKept: 6 }
		});
		const page = value(await service.load(id));
		const app = path('src/app.ts');
		expect(fileUnitInSet(page.fresh, app)).toBe(true);
		expect(fileUnitInSet(page.reviewed, app)).toBe(false);
		expect(marked(page, 'src/app.ts', 'new')).toEqual([6, 11]);
		expect(page.update === undefined ? '' : describeUpdate(page.update.summary)).toMatch(
			/^1 file changed: 1 change new to review\./
		);
		service.close();
	});

	it('reads a database written before files with lines had a file-level unit', async () => {
		const { repo, data, service } = await setUp();
		await repo.setExecutable('src/app.ts', true);
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await sortAndMark(service, id);
		const app = path('src/app.ts');
		// The previous code stored a file with lines as line rows only, and no tick on the file itself.
		const raw = new DatabaseSync(join(data, DATABASE_FILE));
		const where = "revision_id = 'v_1' AND path = CAST('src/app.ts' AS BLOB) AND side = 'file'";
		expect(raw.prepare(`DELETE FROM assignments WHERE ${where}`).run().changes).toBe(1);
		expect(raw.prepare(`DELETE FROM reviewed_marks WHERE ${where}`).run().changes).toBe(1);
		// The migration that came with them lists every revision written before it.
		raw.prepare("INSERT INTO revisions_to_check (revision_id) VALUES ('v_1')").run();
		raw.close();

		const page = value(await service.load(id));
		const file = page.diff.byPath.get(app);
		if (file === undefined) throw new Error('src/app.ts');
		// The file-level unit is completed as not sorted yet and not reviewed; its lines keep their state.
		expect(fileAssignment(page.state, file).file).toEqual({
			bucket: { kind: 'uncategorised' },
			role: 'code'
		});
		expect(bucket(page, 'src/app.ts', 'new', 6)).toBe('app');
		expect(fileUnitInSet(page.reviewed, app)).toBe(false);
		expect(marked(page, 'src/app.ts', 'new')).toEqual([6, 11]);
		// It and the third line of src/new.ts.
		expect(page.progress.uncategorised).toBe(2);
		// Sorting and ticking it works, and is stored as a row of its own.
		value(await service.assign(id, FIRST, [{ file: 'src/app.ts', lines: 'file', section: 'app' }]));
		value(await service.markReviewed(id, FIRST, { kind: 'file', path: app }, true));
		const again = value(await service.load(id));
		expect(fileAssignment(again.state, file).file?.bucket).toEqual({
			kind: 'section',
			section: 'app'
		});
		expect(fileUnitInSet(again.reviewed, app)).toBe(true);
		service.close();
	});

	it('gives the list, the page and the command one progress for a diff saved before then', async () => {
		const repo = await emptyRepo();
		await repo.write('pnpm-lock.yaml', lines(...numbered(12)));
		await repo.commit('first');
		await repo.remove('pnpm-lock.yaml');
		await repo.write(
			'sub/pnpm-lock.yaml',
			lines(...numbered(5), 'changed 6', ...numbered(12).slice(6))
		);
		const data = await tempDirectory();
		const first = await serviceFor(data);
		created(value(await first.open(repo.dir, spec('working-tree'))));
		first.close();
		// As the previous code stored it: the moved lockfile's lines only, both ignored.
		const raw = new DatabaseSync(join(data, DATABASE_FILE));
		const where = "revision_id = 'v_1' AND side = 'file'";
		expect(raw.prepare(`DELETE FROM assignments WHERE ${where}`).run().changes).toBe(1);
		raw
			.prepare(
				"UPDATE revisions SET counted_units = 0, reviewed_units = 0, ignored_units = 2, uncategorised_units = 0 WHERE id = 'v_1'"
			)
			.run();
		raw.prepare("INSERT INTO revisions_to_check (revision_id) VALUES ('v_1')").run();
		raw.close();

		const service = await serviceFor(data);
		const expected = { counted: 0, reviewed: 0, ignored: 3, uncategorised: 0 };
		const [listed] = value(service.list());
		expect(listed?.kind === 'report' ? listed.progress : listed).toEqual(expected);
		// Running the command again: nothing changed, and it says what the list says.
		const again = value(await service.open(repo.dir, spec('working-tree')));
		if (again.kind !== 'resumed') throw new Error(`expected it resumed, got ${again.kind}`);
		expect(again.report.progress).toEqual(expected);
		const page = value(await service.load(again.report.id));
		expect(page.summary.progress).toEqual(expected);
		expect(page.progress.ignored.units).toBe(3);
		service.close();
	});

	it('counts a file once when it became binary, and a deleted file once when it came back', async () => {
		const { repo, service } = await setUp();
		await repo.remove('README.md');
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/app.ts', new Uint8Array([0, 1, 2, 0, 255]));
		await repo.write('README.md', '# Something else\n');
		const updated = value(await service.update(id));
		expect(updated).toMatchObject({ kind: 'updated', summary: { filesChanged: 2, filesGone: 0 } });
		service.close();
	});

	it('refuses a tick, a sorting and sections made on a version that has since been updated', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/new.ts', lines('new 1', 'new 2', 'new 3', 'new 4'));
		expect(value(await service.update(id)).kind).toBe('updated');
		const app = { kind: 'file', path: path('src/app.ts') } as const;
		const refusals = [
			await service.markReviewed(id, FIRST, app, true),
			await service.assign(id, FIRST, [{ file: 'src/new.ts', section: 'ignored', reason: 'x' }]),
			await service.upsertSections(id, FIRST, [{ id: 'app', title: 'The app' }])
		];
		for (const refused of refusals) {
			expect(refused.ok ? undefined : refused.error).toEqual({
				kind: 'VersionOutOfDate',
				report: id,
				seen: 1,
				current: 2
			});
		}
		const page = value(await service.load(id));
		expect(page.reviewed.files.size).toBe(0);
		expect(page.sections).toEqual([]);
		// Made on the version it shows, the same tick is saved.
		const seen = page.revision.number;
		expect(value(await service.markReviewed(id, seen, app, true)).units).toBe(3);
		service.close();
	});

	it('answers checks made at the same time from one look at the files', async () => {
		const repo = (await setUp()).repo;
		const data = await tempDirectory();
		const who = await reviewer();
		const ids = sequentialIds();
		let snapshots = 0;
		const counting: IdSource = {
			reportId: () => ids.reportId(),
			revisionId: () => ids.revisionId(),
			reviewMark: () => ids.reviewMark(),
			snapshotId: () => {
				snapshots += 1;
				return ids.snapshotId();
			}
		};
		const service = value(
			await ReportService.open({
				dataDirectory: data,
				clock: settableClock(at(1_700_000_000_000)),
				ids: counting,
				repository: { gitEnv: who.gitEnv }
			})
		);
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.write('src/new.ts', lines('new 1', 'new 2', 'new 3', 'new 4'));
		const before = snapshots;
		// Several tabs, or a page that got the focus and became visible at once.
		const answers = await Promise.all([
			service.checkForChanges(id),
			service.checkForChanges(id),
			service.checkForChanges(id)
		]);
		expect(answers.map(value)).toEqual(Array(3).fill({ kind: 'changed', files: 1 }));
		expect(snapshots - before).toBe(1);
		expect(await snapshotCount(data)).toBe(2);
		service.close();
	});
});
