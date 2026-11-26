/**
 * `add_notes` (DESIGN 5, 7.1) as an agent meets it, over the daemon's `/mcp`,
 * with what was stored read back through a report service of its own on the
 * same data folder: notes are added and checked, refused on a version that
 * has moved on, replaced on a sort sent again, and, promoted, become one of
 * the reviewer's comments, while one not promoted never reaches the review.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { testDaemon } from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { mcpOverHttp, reportIn } from '../../../../tests/support/mcp-client.ts';
import { buildShop } from '../../../../tests/support/scripted-categorisation.ts';
import { ReportService } from '../reports/index.ts';

const shop = defineFixture('agent-notes-shop', buildShop);

describe('agent notes, through the MCP server', () => {
	it('adds notes on lines, refuses an old version, replaces them, and keeps them out of the review', async () => {
		const repo = await useFixture(shop);
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		const session = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: repo.dir
		});
		onTestFinished(() => session.close());
		const report = reportIn(await session.call('create_report', { source: 'working-tree' }));
		const service = value(
			await ReportService.open({
				dataDirectory,
				ids: sequentialIds(),
				clock: settableClock(value(parseTimestamp(0)))
			})
		);
		onTestFinished(() => {
			service.close();
		});
		const id = value(parseReportId(report));
		const one = value(parseRevisionNumber(1));

		const wrong = await session.call('add_notes', {
			report,
			version: 1,
			notes: [
				{ label: 'risk', file: 'src/pricing.ts', lines: '+2', text: 'Rounds up.' },
				{ label: 'bug', file: 'src/pricing.ts', lines: '+2', text: 'Not a label.' }
			]
		});
		expect(wrong.refused).toBe(true);
		expect(wrong.text).toMatch(/label/);
		const twoRanges = await session.call('add_notes', {
			report,
			version: 1,
			notes: [{ label: 'risk', file: 'src/pricing.ts', lines: '+2,+14', text: 'Two places.' }]
		});
		expect(twoRanges.refused).toBe(true);
		expect(twoRanges.text).toContain(
			'No notes were added; nothing in this call was applied:\n- Note 0: "lines" must be one range on one side'
		);

		const notes = [
			{
				label: 'possible bug',
				file: 'src/pricing.ts',
				lines: '+1..+3',
				text: 'Rounds **up** to 5 cents: is that meant for refunds too?'
			},
			{ label: 'info', file: 'src/cart.ts', lines: '+4', text: 'Every total now rounds.' }
		];
		const added = await session.call('add_notes', { report, version: 1, notes });
		expect(added.refused).toBe(false);
		expect(added.text).toMatch(/^Report r_\w+: .*, version 1\.\nAdded 2 notes\./);
		const again = await session.call('add_notes', { report, version: 1, notes });
		expect(again.text).toContain('Added no notes. 2 notes were on version 1 already');

		const stored = value(await service.load(id)).notes;
		expect(
			stored.map((n) => [n.label, n.anchor.path, n.anchor.side, n.anchor.first, n.anchor.last])
		).toEqual([
			['possible bug', 'src/pricing.ts', 'new', 2, 2],
			['info', 'src/cart.ts', 'new', 4, 4]
		]);
		const [bug, info] = stored;
		if (bug === undefined || info === undefined) throw new Error('missing notes');

		// The reviewer dismisses one and promotes the other; a sort sent again replaces neither.
		value(service.setNoteState(id, one, info.id, 'dismissed'));
		const promoted = value(await service.promoteNote(id, one, bug.id));
		expect(promoted.comment?.body).toBe(
			'From an agent note (possible bug):\n> Rounds **up** to 5 cents: is that meant for refunds too?'
		);
		const replaced = await session.call('add_notes', {
			report,
			version: 1,
			replace: true,
			notes: [
				{ label: 'question', file: 'src/pricing.ts', lines: '+14..+15', text: 'Is 0 allowed?' }
			]
		});
		expect(replaced.text).toContain('Added 1 note.');
		expect(replaced.text).toContain(
			'Version 1 holds 3 notes now; the person has dismissed or promoted 2 of them.'
		);
		expect(value(await service.load(id)).notes.map((n) => [n.label, n.state])).toEqual([
			['possible bug', 'promoted'],
			['info', 'dismissed'],
			['question', 'waiting']
		]);

		// What would be handed over holds the promoted comment and nothing of the other notes.
		const preview = value(await service.previewReview(id, one));
		expect(preview.text).toContain('From an agent note (possible bug)');
		expect(preview.text).not.toContain('Every total now rounds');
		expect(preview.text).not.toContain('Is 0 allowed');

		await repo.write('src/cart.ts', 'export const cart = [];\n');
		await session.call('create_report', { source: 'working-tree' });
		const late = await session.call('add_notes', { report, version: 1, notes });
		expect(late.refused).toBe(true);
		expect(late.text).toMatch(/^The diff changed since you read it: you sent "version": 1/);
		// A note belongs to the version it was written on: the new version starts with none.
		expect(value(await service.load(id)).notes).toEqual([]);
	});
});
