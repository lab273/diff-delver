import { test } from '../support/journey.ts';

// r marks the file the reviewer is on as reviewed and goes on to the next one
// waiting. Each press is one file, however the presses come.
test.describe('Marking files reviewed with r', () => {
	test('marks one file a press, whatever comes between the presses', async ({ journey }) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		await journey.open(opened.address);
		const review = journey.byRole('complementary', { name: 'Your review' });
		await journey.activate(journey.byRole('button', { name: /^Start reviewing/ }));
		const cart = journey.byRole('article', { name: 'src/cart.ts' });
		const checkout = journey.byRole('article', { name: 'src/checkout.ts' });
		const tickOf = (file: string): ReturnType<typeof journey.byRole> =>
			journey.byRole('checkbox', { name: `Reviewed: ${file}` });
		await journey.expectFocused(
			journey.within(cart).byRole('button', { name: 'src/cart.ts', exact: true })
		);

		// Held down, r repeats, and marks only the one file it was pressed on.
		await journey.holdKey('r', 8);
		await journey.expectState(tickOf('src/cart.ts'), { checked: true });
		await journey.expectFocused(
			journey.within(checkout).byRole('button', { name: 'src/checkout.ts', exact: true })
		);
		await journey.expectText(review, '6 of 14 changes reviewed');
		await journey.expectState(tickOf('src/checkout.ts'), { checked: false });
		await journey.step('Held down, r marks one file');

		// The diff is updated while the page is left on the version before: r is
		// refused, says so once, and the press made while it waited is dropped.
		await journey.editFile(
			shop,
			'src/discount.ts',
			'export const discount = (code?: string) => (code === undefined ? 0 : 10);\n'
		);
		await journey.command([], shop);
		await journey.returnToPage();
		await journey.expectVisible(
			journey.byRole('region', { name: 'This Delve has a newer version' })
		);
		const held = await journey.holdTick();
		await journey.press('r');
		await held.requested;
		await journey.press('r');
		held.release();
		await journey.expectText(
			journey.within(checkout).byRole('alert'),
			'Nothing was marked. This Delve was updated to version 2 after you last looked at it'
		);
		await journey.expectState(tickOf('src/checkout.ts'), { checked: false });
		await journey.expectText(review, '6 of 14 changes reviewed');
		await journey.step('r refused once', {
			refusals: [{ route: '/api/diffs/[id]/reviewed', status: 409, times: 1 }]
		});
	});
});
