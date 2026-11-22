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
		for (let i = 0; i < 4; i += 1) await journey.scroll('PageDown');
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
		for (let i = 0; i < 8; i += 1) await journey.scroll('PageDown');
		await expect.poll(() => journey.verticalPosition(original)).toBeLessThan(-4_500);
		await journey.press('b');
		const announcement = journey.byText(/^Bookmarked data\/rows\.txt, line \d+\.$/);
		await journey.expectVisible(announcement);
		const line = (await journey.textOf(announcement)).match(/line (\d+)\./)?.[1];
		expect(Number(line)).toBeGreaterThan(250);
		const savedLine = { name: new RegExp(`old line ${line ?? ''}$`) };
		await journey.expectInView(journey.within(original).byRole('row', savedLine));
		const bookmark = journey.byRole('button', { name: `Return to bookmark ${file}` });
		await journey.expectVisible(bookmark);
		await journey.open(await journey.address());
		await journey.expectVisible(bookmark);
		await journey.press('Shift+KeyB');
		const restored = journey.within(original).byRole('row', savedLine);
		await journey.expectFocused(restored);
		await journey.expectUncovered(restored);
		await journey.step('A bookmark deep in a large change');

		await moveTo('after');
		await journey.returnToPage();
		await journey.expectVisible(moved);
		await journey.press('Shift+KeyB');
		await journey.expectFocused(journey.within(moved).byRole('row', savedLine));
		await journey.expectUncovered(journey.within(moved).byRole('row', savedLine));
		await journey.step('A bookmark after its file moves sections');

		await journey.press('/');
		const search = journey.byRole('search', { name: 'Search the diff' });
		const reviewed = journey.within(moved).byRole('checkbox', { name: `Reviewed: ${file}` });
		const toggle = journey.within(moved).byRole('button', { name: file });
		await journey.expectInView(toggle);
		expect(await journey.verticalPosition(moved)).toBeLessThan(-2_000);
		await journey.expectUncovered(reviewed);
		expect(await journey.verticalPosition(reviewed)).toBeGreaterThan(
			await journey.verticalPosition(search)
		);
		await journey.step('The file header stays below search');

		await journey.expectCollapse(toggle, 'no-preference', () =>
			journey.activate(reviewed, 'Space')
		);
		await journey.expectFocused(journey.byRole('heading', { name: 'Everything is reviewed' }));

		await journey.activate(reviewed, 'Space');
		await journey.expectState(toggle, { expanded: true });
		await journey.expectCollapse(toggle, 'reduce', () => journey.activate(reviewed, 'Space'));
	});
});
