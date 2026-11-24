import { test } from '../support/journey.ts';

// J19 Move between Delves: with two Delves of one repository and one of
// another, the reviewer goes from a Delve to another through the panel that
// lists the others, opens the choose page for the Delve's repository from the
// panel and opens a branch there, and gets to the list from the header. No
// terminal after the Delves exist, and the keyboard only.
test.describe('J19 Move between Delves', () => {
	test('the reviewer switches Delves and opens something new without leaving the browser', async ({
		journey
	}) => {
		const shop = await journey.repository('history');
		const reading = await journey.repository('reading');
		await journey.command(['open', 'HEAD'], shop);
		await journey.command([], reading);
		const opened = await journey.command(['open', 'HEAD~1'], shop);
		await journey.open(opened.address);
		const first = 'Commit HEAD~1';
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: first }));

		// One key opens the panel, from anywhere on the page: the other Delves, most recently
		// active first, and the way to open something new in this Delve's repository.
		await journey.press('d');
		const panel = journey.byRole('dialog', { name: 'Other Delves' });
		const others = journey.within(panel).byRole('list', { name: 'Other Delves' });
		await journey.expectText(others, /The last commit.*Uncommitted changes/s);
		await journey.expectVisible(
			journey.within(panel).byRole('link', { name: 'Choose commits or a branch in shop' })
		);
		await journey.step('The other Delves, from a Delve');

		// Escape puts it away; the header's button opens it again.
		await journey.press('Escape');
		await journey.expectHidden(panel);
		const header = journey.byRole('banner');
		await journey.activate(journey.within(header).byRole('button', { name: 'Other Delves' }));
		await journey.expectVisible(panel);
		const second = 'The last commit';
		await journey.activate(journey.within(panel).byRole('link', { name: second }));
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: second }));
		await journey.expectHidden(panel);
		await journey.step('Another Delve, opened from the panel');

		// Something new in this repository: the choose page, from the rail's button.
		await journey.activate(
			journey
				.within(journey.byRole('complementary', { name: 'Your review' }))
				.byRole('button', { name: 'Other Delves' })
		);
		await journey.activate(
			journey.within(panel).byRole('link', { name: 'Choose commits or a branch in shop' })
		);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Choose what to review in shop' })
		);
		await journey.activate(
			journey.byRole('button', {
				name: 'Review the whole branch: 3 commits, compared with origin/main'
			})
		);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'discounts compared with origin/main' })
		);
		await journey.step('A branch opened from the choose page');

		// The header leads to the list of Delves, from any page.
		await journey.activate(journey.within(header).byRole('link', { name: 'Your Delves' }));
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		await journey.expectVisible(journey.byRole('link', { name: 'Commit HEAD~1' }));
		await journey.step('The list of Delves, from the header');
	});
});
