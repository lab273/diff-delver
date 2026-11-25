/**
 * Counting the binary files of versions an earlier diff delver saved without
 * them: never before the daemon serves, one version at a time once it does,
 * each Delve's current version first, and a version read before its turn is
 * counted then.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { clientOf, testDaemon } from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { buildImages, STAMP } from '../../../../tests/support/image-fixtures.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { startOutcome } from '../cli/outcome.ts';
import { DATABASE_FILE } from '../db/index.ts';
import { withStoreLock } from '../store/store-lock.ts';
import { ReportService } from './index.ts';

const images = defineFixture('catch-up-images', buildImages);
const words = defineFixture('catch-up-words', async (repo) => {
	await repo.write('notes.txt', 'one\n');
	await repo.commit('Start');
	await repo.write('notes.txt', 'two\n');
});

/** A data folder with two Delves: the images' at its third version, and one of text alone. */
async function dataWithVersions(): Promise<{
	data: AbsolutePath;
	/** Each Delve's binary words as the list gave them when the versions were made. */
	listed: ReadonlyMap<string, string | null>;
	imagesId: string;
}> {
	const data = await tempDirectory();
	const daemon = await testDaemon({ dataDirectory: data });
	const client = clientOf(daemon);
	const pictures = await useFixture(images);
	const opened = await startOutcome(client, pictures.dir);
	await pictures.write('assets/extra.png', STAMP);
	await startOutcome(client, pictures.dir);
	await pictures.remove('assets/extra.png');
	await pictures.write('assets/other.png', STAMP);
	await startOutcome(client, pictures.dir);
	await startOutcome(client, (await useFixture(words)).dir);
	const listed = binaryTexts(value(await client.listDiffs()).diffs);
	await daemon.stop();
	return { data, listed, imagesId: opened.page.split('/').at(-1) ?? '' };
}

/** Each listed Delve's binary words, by id. */
function binaryTexts(
	diffs: readonly ({ kind: 'diff'; id: string; binaryText: string | null } | { kind: string })[]
): ReadonlyMap<string, string | null> {
	const texts = new Map<string, string | null>();
	for (const d of diffs) if ('binaryText' in d) texts.set(d.id, d.binaryText);
	return texts;
}

interface StoredRevision {
	readonly id: string;
	readonly report: string;
	readonly number: number;
	readonly counted: boolean;
}

/** Each version as stored, and whether its binary files are counted. */
function storedRevisions(data: AbsolutePath): readonly StoredRevision[] {
	const raw = new DatabaseSync(join(data, DATABASE_FILE), { readOnly: true });
	const rows = raw
		.prepare(
			'SELECT id, report_id, number, binary_added_files IS NOT NULL AS counted FROM revisions ORDER BY report_id, number'
		)
		.all();
	raw.close();
	return rows.map((r) => ({
		id: String(r.id),
		report: String(r.report_id),
		number: Number(r.number),
		counted: Number(r.counted) === 1
	}));
}

/** Forgets every version's binary files, as a database an earlier diff delver wrote has none. */
function forgetBinaryFiles(data: AbsolutePath): void {
	const raw = new DatabaseSync(join(data, DATABASE_FILE));
	raw.exec(
		'UPDATE revisions SET binary_added_files = NULL, binary_added_bytes = NULL, binary_removed_files = NULL, binary_removed_bytes = NULL, binary_changed_files = NULL, binary_changed_before = NULL, binary_changed_after = NULL'
	);
	raw.close();
}

describe('the binary files of versions saved without them', () => {
	it('are counted after the daemon answers, current versions first, and then listed and shown', async () => {
		const { data, listed, imagesId } = await dataWithVersions();
		const imagesText = listed.get(imagesId);
		expect(imagesText).toMatch(/binary files/);
		forgetBinaryFiles(data);
		const before = storedRevisions(data);
		expect(before).toHaveLength(4);

		// Every store held, so no count can read a snapshot until the test lets it.
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stores = await readdir(join(data, 'stores'));
		const held = stores.map((name) =>
			withStoreLock(
				value(parseAbsolutePath(join(data, 'stores', name))),
				'exclusive',
				() => released
			)
		);

		const daemon = await testDaemon({ dataDirectory: data });
		const client = clientOf(daemon);
		// It answers with no count made: the list says nothing of binary files yet.
		const waiting = value(await client.listDiffs()).diffs;
		expect([...binaryTexts(waiting).values()]).toEqual([null, null]);
		expect(storedRevisions(data).filter((r) => r.counted)).toEqual([]);

		release();
		await Promise.all(held);
		const counted = await daemon.binaryCounted;
		const newest = (r: StoredRevision): boolean =>
			before.every((o) => o.report !== r.report || o.number <= r.number);
		const byId = new Map(before.map((r) => [r.id, r]));
		const order = counted.map((id) => byId.get(id));
		expect(order.map((r) => r !== undefined && newest(r))).toEqual([true, true, false, false]);
		expect(storedRevisions(data).every((r) => r.counted)).toBe(true);

		expect(binaryTexts(value(await client.listDiffs()).diffs)).toEqual(listed);
		const page = value(await client.loadDiff(value(parseReportId(imagesId))));
		expect(page.summary.binaryText).toBe(imagesText);
	});

	it('are counted when a version is read before its turn', async () => {
		const { data, listed, imagesId } = await dataWithVersions();
		forgetBinaryFiles(data);
		const service = value(
			await ReportService.open({
				dataDirectory: data,
				clock: settableClock(at(1_800_000_000_000)),
				ids: sequentialIds('later-')
			})
		);
		try {
			const id = value(parseReportId(imagesId));
			// Opening the service counts nothing.
			expect(
				value(service.list()).map((d) => (d.kind === 'report' ? d.binary : 'damaged'))
			).toEqual([undefined, undefined]);
			const page = value(await service.load(id));
			expect(page.summary.binary).toBeDefined();
			const after = value(service.list());
			const imagesNow = after.find((d) => d.kind === 'report' && d.id === id);
			const other = after.find((d) => d.kind === 'report' && d.id !== id);
			expect(imagesNow?.kind === 'report' ? imagesNow.binary : undefined).toEqual(
				page.summary.binary
			);
			expect(other?.kind === 'report' ? other.binary : 'none').toBeUndefined();
			expect(listed.get(imagesId)).toMatch(/binary files/);
			// Only the version read was counted.
			expect(storedRevisions(data).filter((r) => r.counted)).toHaveLength(1);
		} finally {
			service.close();
		}
	});
});
