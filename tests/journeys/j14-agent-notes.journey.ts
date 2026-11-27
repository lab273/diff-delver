import { expect, test } from '../support/journey.ts';

// J14 Agent notes: the agent points at lines with add_notes. Each note is drawn
// at its lines as an agent note, after the reviewer's own; `a` hides them all
// and shows them again; one is dismissed with a press and brought back; one is
// promoted into the review as a comment of the reviewer's own, and only that
// one is in the review finished. Keyboard only.
test.describe('J14 Agent notes', () => {
	test('the reviewer hides the notes, dismisses one and promotes one into the review', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		const report = new URL(opened.address).pathname.split('/').at(-1);
		await journey.agentCall('add_notes', {
			report,
			version: 1,
			notes: [
				{
					label: 'possible bug',
					file: 'src/discount.ts',
					lines: '+4',
					text: 'A code that is not in `CODES` gives no discount and says nothing: should it be refused?'
				},
				{
					label: 'info',
					file: 'src/discount.ts',
					lines: '+1',
					text: 'Codes are fixed here; nothing reads them from settings.'
				},
				{
					label: 'question',
					file: 'src/cart.ts',
					lines: '+6',
					text: 'Is the discount meant to apply before rounding?'
				}
			]
		});
		await journey.open(opened.address);

		const discount = journey.within(journey.byRole('article', { name: 'src/discount.ts' }));
		const cart = journey.within(journey.byRole('article', { name: 'src/cart.ts' }));
		const summary = journey.within(journey.byRole('region', { name: 'Agent notes' }));
		const bar = journey.within(journey.byRole('region', { name: 'Your draft review' }));
		const bug = discount.byRole('article', { name: 'Agent note on After, line 4: Possible bug' });
		const info = discount.byRole('article', { name: 'Agent note on After, line 1: Info' });
		const question = cart.byRole('article', { name: 'Agent note on After, line 6: Question' });

		await journey.expectVisible(summary.byText('3 notes waiting', { exact: false }));
		await journey.expectVisible(bar.byText('3 agent notes waiting', { exact: true }));
		await journey.expectVisible(
			journey.within(bug).byText('should it be refused?', { exact: false })
		);
		await journey.expectVisible(question);
		await journey.step('Agent notes at their lines');

		// `a` hides every note at once; they are still counted. `a` again shows them.
		await journey.press('a');
		await journey.expectHidden(bug);
		await journey.expectHidden(question);
		await journey.expectState(summary.byRole('button', { name: 'Show agent notes' }), {
			pressed: false
		});
		await journey.expectVisible(summary.byText('3 notes waiting', { exact: false }));
		await journey.step('Agent notes hidden');
		await journey.press('a');
		await journey.expectVisible(bug);

		// One is dismissed with a press, and brought back from the list above the diff.
		await journey.activate(
			journey
				.within(info)
				.byRole('button', { name: 'Dismiss the agent note on After, line 1, info' })
		);
		await journey.expectHidden(info);
		await journey.expectVisible(summary.byText('2 notes waiting, 1 dismissed', { exact: false }));
		await journey.expectVisible(bar.byText('2 agent notes waiting', { exact: true }));
		await journey.step('A note dismissed');
		await journey.activate(summary.byRole('button', { name: 'Bring back dismissed notes' }));
		await journey.expectVisible(info);
		await journey.expectFocused(summary.byRole('button', { name: 'Show agent notes' }));
		await journey.activate(
			journey
				.within(info)
				.byRole('button', { name: 'Dismiss the agent note on After, line 1, info' })
		);
		await journey.expectHidden(info);

		// Promoted, a note becomes a comment of the reviewer's own, quoting the agent.
		await journey.activate(
			journey.within(bug).byRole('button', {
				name: 'Promote the agent note on After, line 4, possible bug, to your review'
			})
		);
		const promoted = journey.within(
			discount.byRole('article', { name: 'Your comment on After, line 4' })
		);
		await journey.expectVisible(
			promoted.byText('From an agent note (possible bug):', { exact: false })
		);
		await journey.expectHidden(bug);
		await journey.expectVisible(bar.byText('1 comment', { exact: true }));
		await journey.expectVisible(bar.byText('1 agent note waiting', { exact: true }));
		await journey.step('A note promoted into the review');

		// Finished, the review holds the promoted note and none of the others.
		await journey.activate(bar.byRole('button', { name: 'Finish your review', exact: true }));
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		await journey.activate(finish.byRole('button', { name: 'Finish and copy', exact: true }));
		await journey.expectVisible(
			finish.byText('Review 1 is finished and copied.', { exact: false })
		);
		const copied = await journey.readClipboard();
		expect(copied).toContain('### src/discount.ts:4 (new)');
		expect(copied).toContain('> From an agent note (possible bug):');
		expect(copied).toContain('should it be refused?');
		expect(copied).not.toContain('apply before rounding');
		expect(copied).not.toContain('nothing reads them from settings');
		await journey.step('The review finished with the promoted note');
	});
});
