import { expect, test } from '../support/journey.ts';

// J8 The diff changes mid-review, as far as the first build step goes: diff
// delver cannot bring a diff up to date yet, so when the files change it says
// so, in the terminal and on the page, and offers the one way to see them as
// they are now: delete the diff and open it again.
test.describe('J8 The diff changes mid-review', () => {
	test('a diff whose files changed says so and opens again as they are now', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		await journey.command([], shop);
		await journey.editFile(
			shop,
			'src/price.ts',
			'export const price = (cents: number) => Math.round(cents) / 100;\n'
		);
		const again = await journey.command([], shop);
		expect(again.output).toContain('Uncommitted changes in shop, opened again where you left it');
		expect(again.output).toContain(
			'The files have changed since this diff was opened, and diff delver cannot bring a diff up to date yet'
		);
		await journey.open(again.address);
		const notice = journey.byRole('region', {
			name: 'The files have changed since this diff was opened'
		});
		await journey.expectText(notice, 'delete this diff and open it again');
		await journey.step('The files have changed');

		await journey.activate(
			journey.within(notice).byRole('button', { name: 'Delete this diff and open it again' })
		);
		const dialog = journey.byRole('dialog', { name: 'Delete this diff and open it again?' });
		await journey.expectText(dialog, 'Then the same changes are opened again');
		await journey.expectFocused(journey.within(dialog).byRole('button', { name: 'Cancel' }));
		await journey.step('Deleting asks first');

		await journey.activate(
			journey.within(dialog).byRole('button', { name: 'Delete and open again' })
		);
		await journey.expectText(
			journey.byRole('status'),
			'No changes in the repository since you opened it.'
		);
		expect(await journey.address()).toBe('/diffs/r_2');
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Uncommitted changes' })
		);
		const notSorted = journey.byRole('region', { name: /Not sorted yet/ });
		await journey.expectVisible(journey.within(notSorted).byText('src/price.ts'));
		await journey.step('Opened again as the files are now');
	});
});
