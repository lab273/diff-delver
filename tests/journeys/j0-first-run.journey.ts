import { expect, test } from '../support/journey.ts';

// J0 First run, as far as this build step goes: the empty home page with the
// one command to run, the command opening a repository's uncommitted changes,
// reading a file, opening the unchanged lines around a change, ticking each
// file with the keyboard and "next unread" until everything is reviewed, and
// home showing it so.
test.describe('J0 First run', () => {
	test('a newcomer runs one command in a repository and reviews the whole diff it opens', async ({
		journey
	}) => {
		// The address `diff-delver serve` prints, before anything has been opened.
		const served = await journey.command(['serve']);
		await journey.open(served.address);

		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		await journey.expectVisible(journey.byText('No Delves yet.'));
		// The token in the address the command opens is taken out of it at once.
		expect(await journey.address()).toBe('/');
		expect(await journey.title()).toBe('diff delver');
		expect(await journey.tabOrder()).toEqual([
			'link "diff delver"',
			'link "Your Delves"',
			'button "Copy the command"'
		]);
		await journey.activate(journey.byRole('button', { name: 'Copy the command' }));
		expect(await journey.readClipboard()).toBe(
			'npx https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz'
		);
		await journey.expectVisible(
			journey.byText('Copied. Paste it into a terminal, in your repository.')
		);
		await journey.step('Start page');

		const shop = await journey.repository('shop');
		const run = await journey.command([], shop);
		expect(run.output).toContain(
			'Uncommitted changes in shop: 4 files changed, 13 lines added and 4 removed.'
		);
		await journey.open(run.address);
		expect(await journey.address()).toBe('/diffs/r_1');
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Uncommitted changes' })
		);
		await journey.expectText(
			journey.byRole('status'),
			'No changes in the repository since you opened it.'
		);
		// The overview: how far the review has got, every group, and one way to start.
		const review = journey.byRole('complementary', { name: 'Your review' });
		await journey.expectText(review, 'Not started: 14 changes to review');
		await journey.expectText(review, '3 changes ignored, not counted');
		const groups = journey.within(review).byRole('navigation', { name: 'Groups' });
		await journey.expectText(groups, 'Not sorted yet');
		await journey.expectText(groups, 'Ignored');
		const notSorted = journey.byRole('region', { name: 'Not sorted yet' });
		await journey.expectVisible(
			journey.within(notSorted).byRole('button', { name: 'src/cart.ts', exact: true })
		);
		const ignored = journey.byRole('region', { name: 'Ignored' });
		await journey.expectVisible(journey.within(ignored).byText('Lockfile'));
		await journey.step('The uncommitted changes');

		// One obvious action: it goes to the first file to read and shows its lines.
		await journey.activate(journey.byRole('button', { name: /^Start reviewing/ }));
		const cart = journey.byRole('article', { name: 'src/cart.ts' });
		await journey.expectFocused(
			journey.within(cart).byRole('button', { name: 'src/cart.ts', exact: true })
		);
		await journey.expectVisible(
			journey.within(cart).byText("import { discount } from './discount.ts';")
		);
		await journey.step('Reading a file');

		// The shortcuts are listed, and Escape puts the list away again.
		await journey.press('?');
		const shortcuts = journey.byRole('dialog', { name: 'Keyboard shortcuts' });
		await journey.expectVisible(shortcuts);
		await journey.expectText(shortcuts, 'Go to the next file you have not reviewed');
		await journey.step('The keyboard shortcuts');
		await journey.press('Escape');
		await journey.expectHidden(shortcuts);

		// r marks the file reviewed and puts it away; n goes to the next one to read.
		await journey.press('r');
		await journey.expectState(
			journey.within(cart).byRole('checkbox', { name: 'Reviewed: src/cart.ts' }),
			{ checked: true }
		);
		await journey.expectText(review, '6 of 14 changes reviewed');
		await journey.press('n');
		const checkout = journey.byRole('article', { name: 'src/checkout.ts' });
		await journey.expectFocused(
			journey.within(checkout).byRole('button', { name: 'src/checkout.ts', exact: true })
		);
		await journey.expectVisible(journey.within(checkout).byText('16 unchanged lines'));

		// The lines above the change, a step at a time, then the whole file, then only the change again.
		await journey.activate(
			journey.within(checkout).byRole('button', { name: 'Show all 16 unchanged lines above' })
		);
		await journey.expectVisible(journey.within(checkout).byText('export interface Order {'));
		await journey.activate(
			journey.within(checkout).byRole('button', { name: 'Show the whole file: src/checkout.ts' })
		);
		await journey.expectVisible(journey.within(checkout).byText('// End of checkout.'));
		await journey.step('The whole file');
		await journey.activate(
			journey.within(checkout).byRole('button', { name: 'Show only the changes: src/checkout.ts' })
		);
		await journey.expectHidden(journey.within(checkout).byText('// End of checkout.'));
		await journey.expectVisible(journey.within(checkout).byText('16 unchanged lines'));
		// Below the change, twenty more at a time.
		await journey.activate(
			journey
				.within(checkout)
				.byRole('button', { name: '20 more unchanged lines: 25 to 44', exact: true })
		);
		await journey.expectVisible(
			journey.within(checkout).byText('export function refund(order: Order): string {')
		);
		await journey.expectVisible(
			journey.within(checkout).byText('1 unchanged line', { exact: true })
		);
		// The button has gone with the lines it opened: focus is on what opens the rest.
		await journey.expectFocused(
			journey.within(checkout).byRole('button', { name: 'Show all 1 unchanged line below' })
		);
		await journey.step('Twenty more unchanged lines');

		// Ticked with its box this time: focus stays on the box, and Space unticks and ticks again.
		const checkoutTick = journey.within(checkout).byRole('checkbox', {
			name: 'Reviewed: src/checkout.ts'
		});
		await journey.activate(checkoutTick, 'Space');
		await journey.expectState(checkoutTick, { checked: true });
		await journey.expectFocused(checkoutTick);
		await journey.expectText(review, '9 of 14 changes reviewed');
		await journey.press('Space');
		await journey.expectState(checkoutTick, { checked: false });
		await journey.expectText(review, '6 of 14 changes reviewed');
		await journey.press('Space');
		await journey.expectState(checkoutTick, { checked: true });
		await journey.expectFocused(checkoutTick);
		await journey.expectText(review, '9 of 14 changes reviewed');
		await journey.press('n');
		const discount = journey.byRole('article', { name: 'src/discount.ts' });
		await journey.expectFocused(
			journey.within(discount).byRole('button', { name: 'src/discount.ts', exact: true })
		);
		await journey.press('r');
		// The last one: the page says everything is reviewed, and moves there.
		await journey.expectFocused(journey.byRole('heading', { name: 'Everything is reviewed' }));
		await journey.expectText(review, 'Everything reviewed: 14 changes');
		await journey.step('Everything is reviewed');

		await journey.activate(journey.byRole('link', { name: 'See all your Delves' }));
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		const listed = journey.nth(journey.byRole('listitem'), 1);
		await journey.expectVisible(
			journey.within(listed).byRole('link', { name: 'Uncommitted changes' })
		);
		await journey.expectText(listed, 'shop');
		await journey.expectText(listed, 'Last active just now');
		await journey.expectText(listed, 'Everything reviewed: 14 changes');
		await journey.step('Home lists the diff as reviewed');
	});
});
