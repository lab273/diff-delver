import { expect, test } from '../support/journey.ts';

// J15 Disk space, as far as the first build step goes: deleting a diff asks
// first, says when its space is freed, and leaves the list as it was otherwise.
// The sizes themselves come with the Storage page in a later step.
test.describe('J15 Disk space', () => {
	test('deleting a diff asks first and says when its space is freed', async ({ journey }) => {
		const shop = await journey.repository('shop');
		await journey.command([], shop);
		const home = await journey.command(['serve']);
		await journey.open(home.address);
		const remove = journey.byRole('button', { name: 'Delete Uncommitted changes in shop' });
		await journey.activate(remove);
		const dialog = journey.byRole('dialog', { name: 'Delete Uncommitted changes in shop?' });
		await journey.expectVisible(dialog);
		await journey.expectText(dialog, 'The space it takes on disk is freed within an hour.');
		// Cancel comes first, so Enter on what has focus never deletes by accident.
		await journey.expectFocused(journey.within(dialog).byRole('button', { name: 'Cancel' }));
		await journey.step('Deleting asks first');

		// Escape keeps it.
		await journey.press('Escape');
		await journey.expectHidden(dialog);
		await journey.expectVisible(journey.byRole('link', { name: 'Uncommitted changes' }));

		await journey.activate(remove);
		await journey.activate(journey.within(dialog).byRole('button', { name: 'Delete' }));
		await journey.expectVisible(
			journey.byText(
				'Deleted Uncommitted changes in shop. Its space on disk is freed within an hour.'
			)
		);
		await journey.expectVisible(journey.byText('No diffs have been opened yet.'));
		expect(await journey.address()).toBe('/');
		await journey.expectFocused(journey.byRole('heading', { level: 1, name: 'Your diffs' }));
		await journey.step('The diff is deleted');
	});
});
