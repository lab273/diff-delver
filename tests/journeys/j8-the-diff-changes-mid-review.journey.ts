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

		// Running the command again opens the same diff in another tab, where the
		// discount is ticked: everything is reviewed there.
		const discountTick = journey.byRole('checkbox', { name: 'Reviewed: src/discount.ts' });
		const again = await journey.command([], shop);
		await journey.inAnotherTab(again.address, async (tab) => {
			const tabReview = tab.byRole('complementary', { name: 'Your review' });
			await tab.expectText(tabReview, '9 of 14 changes reviewed');
			const tabTick = tab.byRole('checkbox', { name: 'Reviewed: src/discount.ts' });
			await tab.activate(tabTick, 'Space');
			await tab.expectState(tabTick, { checked: true });
			await tab.expectVisible(tab.byRole('heading', { name: 'Everything is reviewed' }));
			await tab.step('Everything reviewed in another tab');
		});
		// The first tab is behind. A tick there shows what is stored, the other tab's tick too.
		await journey.expectState(discountTick, { checked: false });
		await journey.tabTo(checkoutTick);
		await journey.press('Space');
		await journey.expectState(checkoutTick, { checked: false });
		await journey.expectState(discountTick, { checked: true });
		await journey.expectText(review, '11 of 14 changes reviewed');
		// Unticked in yet another tab, the discount is shown unticked here as soon as the
		// reviewer comes back, with nothing moved: focus is still on the checkout's box.
		await journey.inAnotherTab((await journey.command([], shop)).address, async (tab) => {
			const tabTick = tab.byRole('checkbox', { name: 'Reviewed: src/discount.ts' });
			await tab.activate(tabTick, 'Space');
			await tab.expectState(tabTick, { checked: false });
			await tab.step('Unticked in another tab');
		});
		await journey.returnToPage();
		await journey.expectState(discountTick, { checked: false });
		await journey.expectText(review, '6 of 14 changes reviewed');
		await journey.expectFocused(checkoutTick);
		await journey.press('Space');
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
		// Ticking a file takes it from the page: focus goes on to the file shown after
		// it, or before it when it was the last, and moving on goes from there.
		const discountArticle = journey.byRole('article', { name: 'src/discount.ts' });
		const checkoutName = journey.within(checkout).byRole('button', {
			name: 'src/checkout.ts',
			exact: true
		});
		await journey.press('j');
		await journey.expectFocused(
			journey.within(discountArticle).byRole('button', { name: 'src/discount.ts', exact: true })
		);
		await journey.press('r');
		await journey.expectHidden(discountArticle);
		await journey.expectFocused(checkoutName);
		await journey.press('j');
		await journey.expectFocused(checkoutName);
		// Everything shown again: the discount is back where it was, and its tick comes off.
		await journey.press('u');
		await journey.press('j');
		await journey.expectFocused(
			journey.within(discountArticle).byRole('button', { name: 'src/discount.ts', exact: true })
		);
		await journey.press('r');
		await journey.expectState(
			journey.within(discountArticle).byRole('checkbox', { name: 'Reviewed: src/discount.ts' }),
			{ checked: false }
		);
		await journey.expectText(review, '7 of 16 changes reviewed');

		// The command updates the diff while the page is left on version 2: a tick
		// sent from it changes nothing, and the page says so and offers the new version.
		await journey.editFile(
			shop,
			'src/discount.ts',
			'export const discount = (code?: string) => (code === undefined ? 0 : 10);\n'
		);
		const later = await journey.command([], shop);
		expect(later.output).toContain(
			'Uncommitted changes in shop, updated to your files as they are now (version 3).'
		);
		// Back on the page, it says so; ticking there anyway changes nothing.
		await journey.returnToPage();
		const newer = journey.byRole('region', { name: 'This Delve has a newer version' });
		await journey.expectText(newer, 'It was updated to version 3 while this page was open');
		await journey.activate(discountTick, 'Space');
		const discount = journey.byRole('article', { name: 'src/discount.ts' });
		await journey.expectText(
			journey.within(discount).byRole('alert'),
			'Nothing was marked. This Delve was updated to version 3 after you last looked at it'
		);
		await journey.expectState(discountTick, { checked: false });
		// The page is refused, as it should be, and says so in place.
		const refusedTick = { route: '/api/diffs/[id]/reviewed', status: 409 };
		await journey.step('A tick from a page that is behind', { refusals: [refusedTick] });
		// A tick of the whole group says so too, under the group's heading, and its box
		// shows again that some of it is reviewed.
		const notSorted = journey.byRole('region', { name: 'Not sorted yet' });
		const groupTick = journey.byRole('checkbox', { name: 'All reviewed: Not sorted yet' });
		await journey.expectState(groupTick, { checked: 'mixed' });
		await journey.activate(groupTick, 'Space');
		await journey.expectText(
			journey.nth(journey.within(notSorted).byRole('alert'), 1),
			'Nothing was marked. This Delve was updated to version 3 after you last looked at it'
		);
		await journey.expectState(groupTick, { checked: 'mixed' });
		await journey.expectFocused(groupTick);
		await journey.step('A group tick from a page that is behind', { refusals: [refusedTick] });

		// Where the tick was refused, the way to the new version is at hand.
		await journey.activate(
			journey.within(notSorted).byRole('button', { name: 'Show the new version' })
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

		await journey.activate(journey.within(nothing).byRole('button', { name: 'Close this Delve' }));
		const closed = journey.byRole('region', { name: 'This Delve is closed' });
		await journey.expectText(closed, 'You closed this Delve. You can still read it.');
		// The button went with its notice: focus is on the notice that took its place.
		await journey.expectFocused(journey.byRole('heading', { name: 'This Delve is closed' }));
		await journey.step('The diff is closed');

		await journey.activate(journey.within(closed).byRole('button', { name: 'Reopen this Delve' }));
		await journey.expectHidden(closed);
		await journey.expectVisible(nothing);
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Nothing is left to review here' })
		);
	});
});
