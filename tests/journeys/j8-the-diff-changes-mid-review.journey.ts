import { CHECKOUT_CHANGED, expect, test } from '../support/journey.ts';

/** The checkout edited once more, two lines above the change already reviewed. */
const CHECKOUT_EDITED_AGAIN = CHECKOUT_CHANGED.map((line, i) =>
	i === 17 ? "\tconst items = count === 1 ? 'one item' : `${count} items`;" : line
);

// J8 The diff changes mid-review: the reviewer ticks two files, edits one of
// them close to what they ticked, and updates. The new lines are marked new,
// the tick near them was taken off and the page says why, the tick far away
// was kept, and "Only what I have not reviewed" shows what is left. A tick
// sent from a page that is behind changes nothing and says so. When the
// changes are committed, the page keeps the diff and offers the commit; a
// closed diff can be reopened.
test.describe('J8 The diff changes mid-review', () => {
	test('ticks carry over an update unless something close to them changed', async ({ journey }) => {
		const shop = await journey.repository('shop');
		const first = await journey.command([], shop);
		await journey.open(first.address);
		const status = journey.byRole('status');
		await journey.expectText(status, 'No changes in the repository since you opened it.');
		const review = journey.byRole('complementary', { name: 'Your review' });

		const cartTick = journey.byRole('checkbox', { name: 'Reviewed: src/cart.ts' });
		const checkoutTick = journey.byRole('checkbox', { name: 'Reviewed: src/checkout.ts' });
		await journey.activate(cartTick, 'Space');
		await journey.expectState(cartTick, { checked: true });
		await journey.activate(checkoutTick, 'Space');
		await journey.expectState(checkoutTick, { checked: true });
		await journey.expectText(review, '9 of 14 changes reviewed');

		// The reviewer edits the checkout close to the change they ticked, and comes back.
		await journey.editFile(shop, 'src/checkout.ts', `${CHECKOUT_EDITED_AGAIN.join('\n')}\n`);
		await journey.returnToPage();
		const changed = journey.byRole('region', { name: 'Your files have changed' });
		await journey.expectText(changed, 'Update to see the 1 file that changed as they are now.');
		await journey.step('The files have changed');

		await journey.activate(journey.within(changed).byRole('button', { name: 'Update' }));
		const updated = journey.byRole('region', { name: 'Updated to version 2 just now' });
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Updated to version 2 just now' })
		);
		await journey.expectText(status, 'No changes in the repository since this version was taken.');
		await journey.expectText(updated, '1 file changed: 2 changes new to review.');
		// Far from the edit, the cart keeps its tick; the checkout's was taken off, and it says why.
		await journey.expectState(cartTick, { checked: true });
		await journey.expectState(checkoutTick, { checked: false });
		const checkout = journey.byRole('article', { name: 'src/checkout.ts' });
		await journey.expectText(
			checkout,
			'You had marked 2 changes here as reviewed. They are unmarked now because lines close to them changed in this version'
		);
		await journey.expectText(checkout, '2 new');
		await journey.expectVisible(
			journey
				.within(checkout)
				.byText("\tconst items = count === 1 ? 'one item' : `${count} items`;")
		);
		await journey.expectVisible(
			journey
				.within(journey.byRole('article', { name: 'src/discount.ts' }))
				.byText('export function discount(sum: number, code: string): number {')
		);
		await journey.expectText(review, '7 of 16 changes reviewed');
		await journey.tabTo(
			journey.within(checkout).byRole('button', { name: 'src/checkout.ts', exact: true })
		);
		await journey.step('Updated: new lines marked and a tick taken off');

		// Only what is left: the cart, reviewed, is put out of the way.
		await journey.press('u');
		await journey.expectState(journey.byRole('button', { name: 'Only what I have not reviewed' }), {
			pressed: true
		});
		await journey.expectHidden(journey.byRole('article', { name: 'src/cart.ts' }));
		await journey.expectVisible(checkout);
		await journey.expectVisible(journey.byRole('article', { name: 'src/discount.ts' }));
		await journey.step('Only what is left to review');
		await journey.press('u');

		// The command updates the diff while the page is left on version 2: a tick
		// sent from it changes nothing, and the page says so and offers the new version.
		await journey.editFile(
			shop,
			'src/discount.ts',
			'export const discount = (code?: string) => (code === undefined ? 0 : 10);\n'
		);
		const again = await journey.command([], shop);
		expect(again.output).toContain(
			'Uncommitted changes in shop, updated to your files as they are now (version 3).'
		);
		const discountTick = journey.byRole('checkbox', { name: 'Reviewed: src/discount.ts' });
		await journey.activate(discountTick, 'Space');
		const discount = journey.byRole('article', { name: 'src/discount.ts' });
		await journey.expectText(
			journey.within(discount).byRole('alert'),
			'Nothing was marked. This diff was updated to version 3 after you last looked at it'
		);
		await journey.expectState(discountTick, { checked: false });
		const newer = journey.byRole('region', { name: 'This diff has a newer version' });
		await journey.expectText(newer, 'It was updated to version 3 while this page was open');
		await journey.step('A tick from a page that is behind');

		// Where the tick was refused, the way to the new version is at hand.
		await journey.activate(
			journey.within(discount).byRole('button', { name: 'Show the new version' })
		);
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Updated to version 3 just now' })
		);

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
		await journey.step('Nothing is left to review');

		await journey.activate(journey.within(nothing).byRole('button', { name: 'Close this diff' }));
		const closed = journey.byRole('region', { name: 'This diff is closed' });
		await journey.expectText(closed, 'You closed this diff. You can still read it.');
		// The button went with its notice: focus is on the notice that took its place.
		await journey.expectFocused(journey.byRole('heading', { name: 'This diff is closed' }));
		await journey.step('The diff is closed');

		await journey.activate(journey.within(closed).byRole('button', { name: 'Reopen this diff' }));
		await journey.expectHidden(closed);
		await journey.expectVisible(nothing);
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Nothing is left to review here' })
		);
	});
});
