import { expect, test } from '../support/journey.ts';

// J15 Disk space: deleting a Delve asks first and says when its space is
// freed; the Storage page, reached from the list, lists each repository's
// store with its Delves and the database, and deletes a Delve too. Journeys
// do not measure sizes, since git's are not the same on every machine, so
// every size here is "Not measured yet"; the figures themselves are tested
// against real stores in the report service's and the API's tests.
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
		await journey.expectText(dialog, 'The space it takes on disk is freed within about an hour.');
		// Cancel comes first, so Enter on what has focus never deletes by accident.
		await journey.expectFocused(journey.within(dialog).byRole('button', { name: 'Cancel' }));
		await journey.step('Deleting asks first');

		// Escape keeps it.
		await journey.press('Escape');
		await journey.expectHidden(dialog);
		await journey.expectVisible(journey.byRole('link', { name: 'Uncommitted changes' }));

		// The Storage page, from the list.
		await journey.activate(
			journey.byRole('link', { name: 'What your Delves take on disk' }),
			'Enter'
		);
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Storage' }));
		expect(await journey.address()).toBe('/storage');
		const store = journey.byRole('region', { name: /^shop/ });
		await journey.expectText(store, 'Not measured yet');
		await journey.expectVisible(
			journey.within(store).byRole('link', { name: 'Uncommitted changes' })
		);
		await journey.expectVisible(
			journey.byRole('heading', {
				level: 2,
				name: 'Your Delves’ details, comments and reviews Not measured yet'
			})
		);
		await journey.step('What Delves take on disk');

		// Deleting from it asks as the list does.
		await journey.activate(
			journey.within(store).byRole('button', { name: 'Delete Uncommitted changes in shop' })
		);
		await journey.expectVisible(dialog);
		await journey.activate(journey.within(dialog).byRole('button', { name: 'Delete' }));
		await journey.expectVisible(
			journey.byText(
				'Deleted Uncommitted changes in shop. Its space on disk is freed within about an hour.'
			)
		);
		await journey.expectHidden(store);
		await journey.expectFocused(journey.byRole('heading', { level: 1, name: 'Storage' }));
		await journey.step('Deleted from the Storage page');

		// The list says so too.
		await journey.activate(journey.byRole('link', { name: 'Your Delves' }), 'Enter');
		await journey.expectVisible(journey.byText('No Delves yet.'));
		// True after a delete as before the first diff: nothing says it is the first.
		await journey.expectVisible(journey.byRole('heading', { level: 2, name: 'Start a Delve' }));
		expect(await journey.address()).toBe('/');
		await journey.step('The diff is deleted');
	});
});
