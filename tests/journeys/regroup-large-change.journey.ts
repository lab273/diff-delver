import { expect, test } from '../support/journey.ts';

test.describe('Regrouping a large change', () => {
	test('keeps the reader deep in an open change when its lines arrive', async ({ journey }) => {
		const repo = await journey.repository('long-file');
		const opened = await journey.command([], repo);
		const report = new URL(opened.address).pathname.split('/').at(-1);
		const file = 'data/rows.txt';
		await journey.agentCall('upsert_sections', {
			report,
			version: 1,
			sections: [
				{ id: 'before', title: 'Before sorting again' },
				{ id: 'after', title: 'After sorting again' }
			]
		});
		const moveTo = (section: string): Promise<void> =>
			journey.agentCall('assign', {
				report,
				version: 1,
				items: [{ file, hunks: ['h1'], section }]
			});
		await moveTo('before');
		await journey.open(opened.address);
		const before = journey.byRole('region', { name: 'Before sorting again' });
		const after = journey.byRole('region', { name: 'After sorting again' });
		const original = journey.within(before).byRole('article', { name: file });
		const moved = journey.within(after).byRole('article', { name: file });
		await journey.activate(
			journey.within(original).byRole('button', { name: 'Show this large change' })
		);
		await journey.expectVisible(journey.within(original).byText('old line 1', { exact: true }));
		for (let i = 0; i < 4; i += 1) await journey.press('PageDown');
		await expect.poll(() => journey.verticalPosition(original)).toBeLessThan(-2_000);
		const deep = await journey.verticalPosition(original);

		const delayed = await journey.holdPartRead(file);
		try {
			await moveTo('after');
			await journey.returnToPage();
			await delayed.requested;
			await journey.expectText(moved, 'Loading the lines…');
		} finally {
			delayed.release();
		}
		await expect.poll(() => journey.verticalPosition(moved)).toBeCloseTo(deep, 0);
		await journey.expectState(journey.within(moved).byRole('button', { name: file }), {
			expanded: true
		});
		await journey.step('Returning to the same depth after regrouping');

		const delayedAgain = await journey.holdPartRead(file);
		const title = journey.byRole('heading', { level: 1, name: 'Uncommitted changes' });
		try {
			await moveTo('before');
			await journey.returnToPage();
			await delayedAgain.requested;
			await journey.expectText(original, 'Loading the lines…');
			await journey.press('Home');
			await journey.expectInView(title);
		} finally {
			delayedAgain.release();
		}
		await journey.expectInView(journey.within(original).byText('old line 1', { exact: true }));
		await journey.expectInView(title);
		await journey.step('Scrolling while the lines load keeps the new place');

		// A restored bookmark must also open the large change and draw its chunk
		// when the fresh page only has the file header.
		for (let i = 0; i < 8; i += 1) await journey.press('PageDown');
		await expect.poll(() => journey.verticalPosition(original)).toBeLessThan(-4_500);
		const bookmarkedDepth = await journey.verticalPosition(original);
		const savedLine = { name: /old line 262$/ };
		await journey.expectInView(journey.within(original).byRole('row', savedLine));
		await journey.press('b');
		const bookmark = journey.byRole('button', { name: `Return to bookmark ${file}` });
		await journey.expectVisible(bookmark);
		await journey.open(await journey.address());
		await journey.expectVisible(bookmark);
		await journey.press('Shift+KeyB');
		await expect
			.poll(async () => Math.abs((await journey.verticalPosition(original)) - bookmarkedDepth))
			.toBeLessThan(21);
		await journey.expectFocused(journey.within(original).byRole('row', savedLine));
		await journey.step('A bookmark deep in a large change');

		await moveTo('after');
		await journey.returnToPage();
		await journey.expectVisible(moved);
		await journey.press('Shift+KeyB');
		await journey.expectFocused(journey.within(moved).byRole('row', savedLine));
		await journey.expectInView(journey.within(moved).byRole('row', savedLine));
		await journey.step('A bookmark after its file moves sections');
	});
});
