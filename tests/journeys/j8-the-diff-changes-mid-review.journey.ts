import { expect, test } from '../support/journey.ts';

// J8 The diff changes mid-review, as far as the pages go before the viewer:
// the page says when the files have changed and changes nothing until asked;
// Update brings the diff up to date and says what it did, and the file list
// marks what is new; running the command again does the same, and a page left
// open says it is out of date. When the changes are committed, the page keeps
// showing the diff and offers the commit; a closed diff can be reopened.
test.describe('J8 The diff changes mid-review', () => {
	test('the diff is brought up to date on request, from the page or the command', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const first = await journey.command([], shop);
		await journey.open(first.address);
		const status = journey.byRole('status');
		await journey.expectText(status, 'No changes in the repository since you opened it.');

		// The reviewer edits a file and comes back: the page says so and waits to be asked.
		await journey.editFile(
			shop,
			'src/price.ts',
			'export const price = (cents: number) => Math.round(cents) / 100;\n'
		);
		await journey.returnToPage();
		const changed = journey.byRole('region', { name: 'Your files have changed' });
		await journey.expectText(changed, 'Update to see the 1 file that changed as they are now.');
		await journey.expectText(journey.byRole('heading', { level: 1 }), 'Uncommitted changes');
		await journey.step('The files have changed');

		await journey.activate(journey.within(changed).byRole('button', { name: 'Update' }));
		const updated = journey.byRole('region', { name: 'Updated to version 2 just now' });
		await journey.expectText(updated, '1 file changed: 2 changes new to review.');
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Updated to version 2 just now' })
		);
		await journey.expectText(status, 'No changes in the repository since this version was taken.');
		const notSorted = journey.byRole('region', { name: /Not sorted yet/ });
		await journey.expectVisible(journey.within(notSorted).byText('2 new changes since version 1'));
		await journey.step('Updated to the files as they are now');

		// Another edit, and the command run again: it updates, and says what it did.
		await journey.editFile(
			shop,
			'src/discount.ts',
			'export const discount = (code?: string) => (code === undefined ? 0 : 10);\n'
		);
		const again = await journey.command([], shop);
		expect(again.output).toContain(
			'Uncommitted changes in shop, updated to your files as they are now (version 3). 1 file changed:'
		);
		// The page left open notices when the reviewer comes back to it.
		await journey.returnToPage();
		const newer = journey.byRole('region', { name: 'This diff has a newer version' });
		await journey.expectText(newer, 'It was updated to version 3 while this page was open');
		await journey.step('A newer version is waiting');

		await journey.open(again.address);
		await journey.expectVisible(
			journey.byRole('region', { name: 'Updated to version 3 just now' })
		);
		await journey.expectText(status, 'No changes in the repository since this version was taken.');
		await journey.step('The command updated it');

		// The changes are committed: the page keeps the diff and offers the commit.
		await journey.commitAll(shop, 'Round prices and add discounts');
		await journey.returnToPage();
		const nothing = journey.byRole('region', { name: 'Nothing is left to review here' });
		await journey.expectText(nothing, 'have most likely been committed');
		await journey.expectVisible(
			journey
				.within(nothing)
				.byRole('button', { name: /^Review commit [0-9a-f]{7}, “Round prices and add discounts”$/ })
		);
		await journey.expectVisible(journey.within(notSorted).byText('src/price.ts'));
		await journey.step('Nothing is left to review');

		await journey.activate(journey.within(nothing).byRole('button', { name: 'Close this diff' }));
		const closed = journey.byRole('region', { name: 'This diff is closed' });
		await journey.expectText(closed, 'You closed this diff. You can still read it.');
		await journey.step('The diff is closed');

		await journey.activate(journey.within(closed).byRole('button', { name: 'Reopen this diff' }));
		await journey.expectHidden(closed);
		await journey.expectVisible(nothing);
	});
});
