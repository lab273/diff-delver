import { expect, test } from '../support/journey.ts';

// J1 Review local changes with an agent: an agent sorts the person's
// uncommitted changes, the person reads them section by section, ticks a file,
// comments on lines, reads what finishing will hand over, and finishes the
// review with one press, which copies it. The agent then reads the same review
// from diff delver with get_review. Keyboard only.
test.describe('J1 Review local changes with an agent', () => {
	test('the reviewer comments, finishes and copies the review, and the agent reads it back', async ({
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
						{ id: 'discounts', title: 'A cart total can take a discount' },
						{ id: 'checkout', title: 'Checkout asks for a code' }
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
			}
		]);
		await journey.open(opened.address);
		await journey.expectVisible(
			journey.byRole('heading', { level: 2, name: 'A cart total can take a discount' })
		);

		// The person reads the first section, ticks a file and comments on a line of another.
		await journey.activate(journey.byRole('checkbox', { name: 'Reviewed: src/cart.ts' }), 'Space');
		const discount = journey.within(journey.byRole('article', { name: 'src/discount.ts' }));
		await journey.activate(
			discount.byRole('button', { name: 'Comment on line 1, after', exact: true })
		);
		const box = journey.within(
			journey.byRole('form', { name: 'New comment on After, line 1', exact: true })
		);
		await journey.expectFocused(box.byRole('textbox', { name: 'Comment', exact: true }));
		await journey.type('Read the codes from settings, not from the code.');
		await journey.activate(box.byRole('button', { name: 'Save comment', exact: true }));
		await journey.expectVisible(journey.byRole('button', { name: 'Draft comments (1)' }));

		// What finishing will hand over can be read first.
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		await journey.expectVisible(
			finish.byText('Finishing makes your 1 comment review 1.', { exact: false })
		);
		await journey.activate(finish.byRole('button', { name: 'Show what will be copied' }));
		const preview = finish.byRole('region', { name: 'What will be copied' });
		await journey.expectText(preview, '### src/discount.ts:1 (new)');
		await journey.expectText(preview, 'Read the codes from settings, not from the code.');
		await journey.step('What finishing will hand over');

		// One press finishes it and copies it.
		await journey.activate(finish.byRole('button', { name: 'Finish and copy' }));
		await journey.expectVisible(
			finish.byText('Review 1 is finished and copied.', { exact: false })
		);
		await journey.expectFocused(finish.byRole('button', { name: 'Copy review 1' }));
		await journey.expectVisible(journey.byRole('button', { name: 'Draft comments (0)' }));
		await journey.expectVisible(
			finish.byText('Your draft has no comments. Your next comment starts review 2.')
		);
		const copied = await journey.readClipboard();
		expect(copied).toContain('# Review 1 of Uncommitted changes in shop\n');
		expect(copied).toContain(
			[
				'### src/discount.ts:1 (new)',
				'```typescript',
				'const CODES: Record<string, number> = { SPRING: 0.1, LOYAL: 0.15 };',
				'```',
				'Read the codes from settings, not from the code.'
			].join('\n')
		);
		expect(copied).toContain('- Section "A cart total can take a discount": src/discount.ts');
		expect(copied).toContain('- Section "Checkout asks for a code": src/checkout.ts');
		await journey.step('The review finished and copied');

		// The agent reads exactly what was copied.
		const answer = await journey.agentCall('get_review', { report });
		expect(answer).toContain(
			`----- The review starts here -----\n${copied.replace(/\n$/, '')}\n----- The review ends here -----`
		);

		// It can be copied again, and read as it was handed over.
		await journey.activate(finish.byRole('button', { name: 'Show review 1' }));
		await journey.expectText(
			finish.byRole('region', { name: 'Review 1 as it was copied' }),
			'Read the codes from settings, not from the code.'
		);
		await journey.step('A finished review, read again');
	});
});
