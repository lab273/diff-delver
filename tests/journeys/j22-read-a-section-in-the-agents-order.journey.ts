import { test } from '../support/journey.ts';

// J22 Read a section in the agent's order: the agent sorts the shop and gives
// its discounts section a reading order, discount() before the cart total that
// calls it, with cart.ts split over two steps and a note on the steps that need
// one. The reviewer reads the steps in that order, each a part of its own with
// the agent's note above its lines and the file's other lines in the section
// shown muted with a link to their step, ticks each step and moves on with `r`,
// and finds the lines no step names after the steps. The agent's summaries
// are read too: `n` goes to a section's summary before its first step, and
// ticking a section's last part with `r` goes to the next section's summary
// before its files. Following a section's link in the rail and pressing n
// goes on from its summary; a summary the agent rewrites is unread again.
// Keyboard only.
test.describe("J22 Read a section in the agent's order", () => {
	test('the reviewer reads and ticks a section step by step, in the order the agent gave', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		const report = new URL(opened.address).pathname.split('/').at(-1) ?? '';
		await journey.agentCalls([
			{
				tool: 'upsert_sections',
				args: {
					report,
					version: 1,
					sections: [
						{
							id: 'discounts',
							title: 'A cart total can take a discount',
							summary: 'discount() applies a code’s rate, and total() takes a code.'
						},
						{
							id: 'checkout',
							title: 'Checkout asks for a code',
							summary: 'checkout() asks for a discount code and passes it on.'
						}
					]
				}
			},
			{
				tool: 'assign',
				args: {
					report,
					version: 1,
					items: [
						{ file: 'src/discount.ts', section: 'discounts' },
						{ file: 'src/cart.ts', section: 'discounts' },
						{ file: 'src/checkout.ts', section: 'checkout' }
					]
				}
			},
			{
				tool: 'set_reading_order',
				args: {
					report,
					version: 1,
					section: 'discounts',
					steps: [
						{
							file: 'src/discount.ts',
							lines: '+3..+5',
							note: 'Read discount() first: total() below calls it.'
						},
						{
							file: 'src/cart.ts',
							lines: '-3..-4,+4..+6',
							note: 'total() takes a code now and passes the sum through discount().'
						},
						{ file: 'src/cart.ts' }
					]
				}
			}
		]);
		await journey.open(opened.address);

		const toggle = (name: string): ReturnType<typeof journey.byRole> =>
			journey.byRole('button', { name, exact: true });
		const tick = (name: string): ReturnType<typeof journey.byRole> =>
			journey.byRole('checkbox', { name, exact: true });
		const first = toggle('src/discount.ts, part 1 of 2, step 1 of 3');
		const second = toggle('src/cart.ts, part 1 of 2, step 2 of 3');
		const third = toggle('src/cart.ts, part 2 of 2, step 3 of 3');
		const after = toggle('src/discount.ts, part 2 of 2, after the steps');

		// The section opens on its first step, with the agent's note above its lines.
		await journey.expectVisible(
			journey.byText('Read discount() first: total() below calls it.', { exact: true })
		);
		// The section's summary is the first thing to read, then its first step.
		await journey.expectVisible(
			journey.byText('Left to read: 14 changes and 2 section summaries', { exact: true })
		);

		// Following a section's link in the rail puts the reader on its summary:
		// n goes on from there, to its file, and reads it.
		const groups = journey.byRole('navigation', { name: 'Groups' });
		await journey.activate(
			journey.within(groups).byRole('link', { name: 'Checkout asks for a code', exact: true })
		);
		await journey.press('n');
		await journey.expectFocused(toggle('src/checkout.ts'));
		await journey.expectVisible(
			journey.byText('Left to read: 14 changes and 1 section summary', { exact: true })
		);
		// A summary the agent rewrites is unread again.
		await journey.agentCall('upsert_sections', {
			report,
			version: 1,
			sections: [
				{
					id: 'checkout',
					summary: 'checkout() asks for a discount code, trims it and passes it on.'
				}
			]
		});
		await journey.returnToPage();
		await journey.expectVisible(
			journey.byText('Left to read: 14 changes and 2 section summaries', { exact: true })
		);

		await journey.press('n');
		await journey.expectFocused(
			journey.byRole('region', { name: 'Agent summary: A cart total can take a discount' })
		);
		await journey.press('n');
		await journey.expectFocused(first);
		await journey.expectVisible(
			journey.byText('Left to read: 14 changes and 1 section summary', { exact: true })
		);
		await journey.step("The first step, with the agent's note");

		// r ticks the step and goes on to the next, a part of cart.ts whose other
		// lines in the section are shown muted, with a link to their step.
		await journey.press('r');
		await journey.expectState(
			tick('Reviewed: src/discount.ts in A cart total can take a discount, step 1'),
			{ checked: true }
		);
		await journey.expectFocused(second);
		await journey.expectVisible(
			journey.byText('total() takes a code now and passes the sum through discount().', {
				exact: true
			})
		);
		await journey.expectVisible(
			journey.byRole('link', { name: 'Go to src/cart.ts in step 3 of this section' })
		);
		await journey.step('The second step, the rest of its file muted');

		// The same file's next step, then the lines no step names, after the steps.
		await journey.press('r');
		await journey.expectFocused(third);
		await journey.press('r');
		await journey.expectFocused(after);
		await journey.expectVisible(
			journey.byRole('link', { name: 'Go to src/discount.ts in step 1 of this section' })
		);
		await journey.step('What no step names comes last');

		// Ticking the section's last part goes to the next section's summary
		// before its file, and r on the summary only goes on from it.
		await journey.press('r');
		await journey.expectState(
			tick('Reviewed: src/discount.ts in A cart total can take a discount'),
			{ checked: true }
		);
		await journey.expectState(
			tick('Reviewed: src/cart.ts in A cart total can take a discount, step 3'),
			{ checked: true }
		);
		await journey.expectFocused(
			journey.byRole('region', { name: 'Agent summary: Checkout asks for a code' })
		);
		await journey.step("Every step ticked, and the next section's summary");

		await journey.press('r');
		await journey.expectFocused(toggle('src/checkout.ts'));
		await journey.expectState(tick('Reviewed: src/checkout.ts'), { checked: false });
		await journey.expectHidden(journey.byText('section summary', { exact: false }));
		await journey.step("The next section's file, its summary read");
	});
});
