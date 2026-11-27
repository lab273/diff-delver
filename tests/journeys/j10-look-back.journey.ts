import { expect, test } from '../support/journey.ts';

/** The discount as the agent leaves it after review 1: its fourth line rewritten. */
const DISCOUNT_FIXED = [
	'const CODES: Record<string, number> = { SPRING: 0.1, LOYAL: 0.15 };',
	'',
	'export function discount(sum: number, code: string): number {',
	'\treturn code in CODES ? sum * (1 - (CODES[code] ?? 0)) : sum;',
	'}'
];

// J10 Look back: the reviewer ticks the cart and comments on the discount,
// finishes review 1, ticks the checkout too, updates the diff after the agent
// changed the discount, resolves the comment and finishes review 2. From the
// Delve they open its history, which lists both versions and both reviews,
// open review 1 and read the text that was handed over, then see the Delve as
// of review 1: version 1, with only the cart ticked, read-only, and go back
// to the current version. Keyboard only.
test.describe('J10 Look back', () => {
	test('the reviewer opens a past review, reads what was handed over and sees the Delve as of it', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		await journey.open(opened.address);
		const discount = journey.within(journey.byRole('article', { name: 'src/discount.ts' }));
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		const finishAndCopy = finish.byRole('button', { name: 'Finish and copy', exact: true });
		const cartTick = journey.byRole('checkbox', { name: 'Reviewed: src/cart.ts' });
		const checkoutTick = journey.byRole('checkbox', { name: 'Reviewed: src/checkout.ts' });

		// Review 1: the cart ticked, and a comment on the discount's codes.
		await journey.activate(cartTick, 'Space');
		await journey.expectState(cartTick, { checked: true });
		const lineOne = discount.byRole('button', {
			name: 'Comment on, flag or ask about line 1, after',
			exact: true
		});
		await journey.tabTo(lineOne);
		await journey.press('Enter');
		await journey.activate(
			journey.byRole('button', { name: 'Comment on After, line 1', exact: true })
		);
		await journey.expectFocused(
			journey
				.within(journey.byRole('form', { name: 'New comment on After, line 1', exact: true }))
				.byRole('textbox', { name: 'Comment', exact: true })
		);
		await journey.type('Should the codes come from settings?');
		await journey.press('Control+Enter');
		await journey.expectVisible(
			discount.byText('Should the codes come from settings?', { exact: true })
		);
		await journey.activate(finishAndCopy);
		await journey.expectVisible(
			finish.byText('Review 1 is finished and copied.', { exact: false })
		);
		const first = await journey.readClipboard();

		// After it, the checkout is ticked too; then the agent changes the discount.
		await journey.activate(checkoutTick, 'Space');
		await journey.expectState(checkoutTick, { checked: true });
		await journey.editFile(shop, 'src/discount.ts', `${DISCOUNT_FIXED.join('\n')}\n`);
		await journey.returnToPage();
		const changed = journey.byRole('region', { name: 'Your files have changed' });
		await journey.activate(journey.within(changed).byRole('button', { name: 'Update' }));
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Updated to version 2 just now' })
		);

		// Review 2 resolves the comment.
		await journey.press('p');
		const comment = journey.byRole('article', {
			name: 'Comment from review 1, Open, on After, line 1'
		});
		await journey.expectFocused(comment);
		await journey.activate(
			journey.within(comment).byRole('button', {
				name: 'Resolve the comment from review 1 on After, line 1',
				exact: true
			})
		);
		await journey.activate(finishAndCopy);
		await journey.expectVisible(
			finish.byText('Review 2 is finished and copied.', { exact: false })
		);

		// The history, from the Delve's rail.
		await journey.activate(
			journey.nth(journey.byRole('link', { name: 'History of this Delve' }), 1)
		);
		await journey.expectVisible(journey.byRole('heading', { name: /^History of / }));
		const timeline = journey.within(journey.byRole('list', { name: 'Versions and reviews' }));
		for (const heading of ['Version 1', 'Review 1', 'Version 2, the current one', 'Review 2']) {
			await journey.expectVisible(timeline.byRole('heading', { name: heading, exact: true }));
		}
		const reviewOne = journey.byRole('listitem', { name: 'Review 1' });
		await journey.expectText(reviewOne, 'Today: 1 resolved.');
		await journey.expectText(reviewOne, 'Copied just now');
		const review1 = journey.within(reviewOne);
		await journey.step("The Delve's history");

		// Review 1, read-only, with exactly what was handed over.
		await journey.activate(review1.byRole('link', { name: 'Read review 1' }));
		await journey.expectVisible(journey.byRole('heading', { name: /^Review 1 of / }));
		const text = journey.byRole('region', { name: 'Review 1 as it was handed over' });
		expect(await journey.textOf(text)).toBe(first.replace(/\n$/, ''));
		await journey.expectText(
			journey.byRole('list', { name: 'What review 1 held' }),
			/Comment\s+src\/discount\.ts, After, line 1\s+on version 1\s+Today: Resolved/
		);
		await journey.step('Review 1 as it was handed over');

		// The Delve as of review 1: version 1, only the cart ticked, nothing to change.
		await journey.activate(journey.byRole('link', { name: 'See the Delve as of review 1' }));
		const asOf = journey.byRole('region', { name: 'As of review 1' });
		await journey.expectVisible(asOf);
		await journey.expectState(cartTick, { checked: true, disabled: true });
		await journey.expectState(checkoutTick, { checked: false, disabled: true });
		// Review 1's own comment at its lines, as it stood then: open.
		await journey.expectVisible(
			journey.byRole('article', { name: 'Comment from review 1, Open, on After, line 1' })
		);
		await journey.expectVisible(
			journey.byRole('heading', { name: 'Comments up to review 1: 1 open' })
		);
		await journey.expectHidden(journey.byRole('region', { name: 'Finish your review' }));
		await journey.step('The Delve as of review 1');

		// Back to the current version, where both are ticked and can be changed.
		await journey.activate(
			journey.within(asOf).byRole('link', { name: 'Back to the current version' })
		);
		await journey.expectHidden(asOf);
		await journey.expectState(cartTick, { checked: true, disabled: false });
		await journey.expectState(checkoutTick, { checked: true, disabled: false });
		await journey.step('Back to the current version');
	});
});
