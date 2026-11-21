import { expect, test } from '../support/journey.ts';

// What Codex made of the shop: its recorded trial
// (tests/agent-trials/recordings/shop.codex.json), replayed on the journey's own
// daemon, as the person then sees it: the sections in reading order, one with
// part of a file another section also has, and what was ignored.
test.describe('Trial shop sorted by Codex', () => {
	test('the sections in reading order, a split file, and what was ignored', async ({ journey }) => {
		const shop = await journey.repository('trial-shop');
		const title = journey.byRole('heading', { level: 1, name: 'Uncommitted changes' });
		let initialTitleTop = 0;
		const address = await journey.agentTrial('shop.codex.json', shop, async (address) => {
			await journey.open(address);
			await journey.expectVisible(journey.byRole('heading', { level: 2, name: 'Not sorted yet' }));
			for (const path of [
				'fixtures/recorded.json',
				'scripts/deploy.sh',
				'src/cart.ts',
				'src/pricing.test.ts',
				'src/pricing.ts'
			]) {
				await journey.expectVisible(journey.byRole('table', { name: `Lines of ${path}` }));
			}
			initialTitleTop = await journey.verticalPosition(title);
		});
		const rail = journey.byRole('complementary', { name: 'Your review' });
		await journey.expectVisible(journey.within(rail).byText('Agent overview', { exact: true }));
		await journey.expectVisible(journey.within(rail).byText(/Item prices now round up/));
		expect(await journey.verticalPosition(title)).toBe(initialTitleTop);
		await journey.expectVisible(
			journey.byRole('heading', { level: 2, name: 'Round item prices up to five cents' })
		);
		await journey.step('Sections in reading order');

		const groups = journey.byRole('navigation', { name: 'Groups' });
		const split = 'Apply a percentage discount to the cart subtotal';
		await journey.activate(journey.within(groups).byRole('link', { name: split, exact: true }));
		await journey.expectInView(journey.byRole('heading', { level: 2, name: split }));
		const section = journey.byRole('region', { name: split, exact: true });
		await journey.expectVisible(journey.within(section).byText('Agent summary', { exact: true }));
		await journey.expectVisible(
			journey.within(section).byText('src/cart.ts +3..+4', { exact: true })
		);
		await journey.step('A section with part of a file');

		await journey.activate(journey.within(groups).byRole('link', { name: 'Ignored', exact: true }));
		await journey.expectInView(journey.byRole('heading', { level: 2, name: 'Ignored' }));
		await journey.step('What was ignored');

		// With the search open, which stays at the top of the screen, a group's
		// heading comes to rest below it, not under it.
		await journey.press('/');
		await journey.expectFocused(journey.byRole('searchbox', { name: 'Search the diff' }));
		await journey.activate(journey.within(groups).byRole('link', { name: split, exact: true }));
		await journey.expectFocused(journey.byRole('heading', { level: 2, name: split }));
		await journey.expectUncovered(journey.byRole('heading', { level: 2, name: split }));
		await journey.step('A heading below the search');

		await journey.press('Escape');
		await journey.activate(journey.within(groups).byRole('link', { name: split, exact: true }));
		const part = journey.within(section).byRole('article', { name: 'src/pricing.ts' });
		const tools = journey.within(part);
		await journey.activate(tools.byRole('button', { name: 'Show the whole file: src/pricing.ts' }));
		const collapse = tools.byRole('button', { name: 'Show only the changes: src/pricing.ts' });
		await journey.expectFocused(collapse);
		await journey.expectInView(collapse);
		const before = await journey.verticalPosition(collapse);

		const report = new URL(address).pathname.split('/').at(-1);
		const summary =
			'The percentage discount is applied to the sum of the rounded item prices. Review the default value, the order of the calculation, and the final rounding together. The pricing file shows how the arithmetic is shared with the rest of the cart. A cart with no discount should still add the same rounded prices, and a discount with a fractional cent should be rounded before it is subtracted from the total.';
		await journey.agentCall('upsert_sections', {
			report,
			version: 1,
			sections: [{ id: 'discount', summary }]
		});
		await journey.returnToPage();
		await journey.expectVisible(journey.within(section).byText(summary, { exact: true }));
		await journey.expectFocused(collapse);
		expect(await journey.verticalPosition(collapse)).toBeCloseTo(before, 0);
		await journey.step('A summary edit keeps the file expanded and focused');

		await journey.agentCall('assign', {
			report,
			version: 1,
			items: [{ file: 'src/pricing.ts', hunks: ['h2'], section: 'rounding' }]
		});
		await journey.returnToPage();
		await journey.expectHidden(part);
		const moved = journey.byRole('button', { name: 'src/pricing.ts', exact: true });
		await journey.expectFocused(moved);
		await journey.expectInView(moved);
		await journey.step('A file stays in view when it moves to another section');

		await journey.press('End');
		const ignored = journey.byRole('heading', { level: 2, name: 'Ignored' });
		await journey.expectInView(ignored);
		await journey.expectFocused(moved);
		await journey.agentCall('assign', {
			report,
			version: 1,
			items: [{ file: 'src/pricing.ts', hunks: ['h2'], section: 'discount' }]
		});
		await journey.returnToPage();
		const rounding = journey.byRole('region', { name: 'Round item prices up to five cents' });
		await journey.expectFocused(
			journey.within(rounding).byRole('button', { name: 'src/pricing.ts, part 1 of 2' })
		);
		await journey.expectInView(ignored);
		await journey.step('Regrouping keeps the place scrolled into view');

		const unsaved = journey.within(journey.byRole('form', { name: 'Unsaved comment' }));
		const draftText = 'Can we explain how the subtotal is rounded?';
		await journey.activate(tools.byRole('button', { name: 'Show the whole file: src/pricing.ts' }));
		await journey.activate(tools.byRole('button', { name: 'Comment on lines', exact: true }));
		await journey.press('Shift+ArrowDown');
		await journey.agentCall('assign', {
			report,
			version: 1,
			items: [{ file: 'src/pricing.ts', hunks: ['h2'], section: 'rounding' }]
		});
		await journey.returnToPage();
		await journey.expectVisible(
			journey.byText('Finish choosing lines to see the updated sections.')
		);
		await journey.expectState(tools.byRole('button', { name: 'Before, line 6', exact: true }), {
			pressed: true
		});
		await journey.expectState(tools.byRole('button', { name: 'Before, line 7', exact: true }), {
			pressed: true
		});
		await journey.press('Enter');
		await journey.expectFocused(unsaved.byRole('textbox', { name: 'Comment', exact: true }));
		await journey.type(draftText);
		await journey.expectHidden(part);
		await journey.activate(unsaved.byRole('button', { name: 'Save draft comment' }));
		await journey.expectVisible(journey.byText('Draft comment saved.'));
		await journey.activate(journey.byRole('button', { name: 'Draft comments', exact: true }));
		await journey.expectVisible(journey.byText(draftText, { exact: true }));
		await journey.expectVisible(journey.byText('Before, lines 6–7'));
	});
});
