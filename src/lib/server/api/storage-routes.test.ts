/**
 * What a Delve takes on disk, through the daemon (DESIGN 9.1): measured in the
 * background from its repeating check a minute after a change, never while a
 * Delve opens, then said on
 * the list of Delves, in what the delete confirmation says, and on the Storage
 * page with the store's and the database's sizes.
 */
import { describe, expect, it } from 'vitest';
import { clientOf, testDaemon } from '../../../../tests/support/daemons.ts';
import { emptyRepo } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { settableClock } from '#lib/core/clock.ts';
import { MEASURE_AFTER_MS } from '../reports/disk-usage.ts';

describe('what a Delve takes on disk, through the daemon', () => {
	it('is measured after it opens, and said on the list and the Storage page', async () => {
		const checks: (() => Promise<void>)[] = [];
		const clock = settableClock(at(1_700_000_000_000));
		const daemon = await testDaemon({
			clock,
			repeat: (check) => {
				checks.push(check);
				return () => undefined;
			}
		});
		const client = clientOf(daemon);
		const repo = await emptyRepo();
		await repo.write('notes.txt', 'one\n');
		await repo.commit('Start');
		await repo.write('notes.txt', 'two\n');
		const opened = value(await client.open({ directory: repo.dir, source: 'working-tree' }));
		if (opened.kind !== 'opened') throw new Error(`expected a Delve, got ${opened.kind}`);
		const listed = async (): Promise<unknown> => {
			const diffs = value(await client.listDiffs()).diffs;
			const found = diffs.find((d) => d.kind === 'diff' && d.id === opened.diff.id);
			return found?.kind === 'diff' ? found.disk : undefined;
		};

		// Opening it measured nothing; the daemon's next check does, in the background.
		expect(await listed()).toBeNull();
		const storage = value(await client.storage());
		expect(storage.stores[0]?.delves[0]?.disk).toBeNull();
		// Measured a minute after the store last changed, by the daemon's clock.
		await Promise.all(checks.map((check) => check()));
		expect(await listed()).toBeNull();
		clock.advance(MEASURE_AFTER_MS);
		await Promise.all(checks.map((check) => check()));
		await expect.poll(listed).not.toBeNull();

		const disk = await listed();
		expect(disk).toMatchObject({
			// A few small objects: two blobs and their trees.
			text: 'Almost nothing on disk',
			inFull: 'Deleting it frees almost nothing.',
			deleting: 'It takes almost no space on disk.'
		});
		const measured = value(await client.storage());
		expect(measured.stores).toHaveLength(1);
		expect(measured.stores[0]?.repository).toBe(opened.diff.repository);
		expect(measured.stores[0]?.sizeText).toMatch(
			/^\d[\d.,]* (bytes|KB|MB) on disk, measured just now$/
		);
		expect(measured.stores[0]?.delves.map((d) => [d.id, d.disk?.text])).toEqual([
			[opened.diff.id, 'Almost nothing on disk']
		]);
		expect(measured.databaseText).toMatch(/^\d[\d.,]* (bytes|KB|MB) on disk, measured just now$/);
	});
});
