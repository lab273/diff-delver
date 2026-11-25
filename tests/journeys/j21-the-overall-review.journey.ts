import { expect, test } from '../support/journey.ts';

// J21 The overall review: at the foot of a Delve's page, a bar the reviewer
// writes their overall review of the change in. Put away, it shows its first
// words and how many comments the draft holds; it is saved as a comment is,
// and comes first in the review finished. Keyboard only.
test.describe('J21 The overall review', () => {
	test('the reviewer writes an overall review, sees it put away, and finds it first in the review copied', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		await journey.open(opened.address);

		const bar = journey.within(journey.byRole('region', { name: 'Overall review' }));
		const toggle = bar.byRole('button', { name: 'Overall review', exact: true });
		const words = bar.byRole('textbox', { name: /^Your overall review of the change/ });
		const save = bar.byRole('button', { name: 'Save overall review', exact: true });

		// Put away at first, it says nothing is written, and that there are no comments yet.
		await journey.expectState(toggle, { expanded: false });
		await journey.expectVisible(bar.byText('Nothing written yet', { exact: true }));
		await journey.expectVisible(bar.byText('No comments yet', { exact: true }));
		await journey.expectInView(toggle);
		await journey.step('The overall review put away, nothing written yet');

		// `v` opens it, and its box takes the keyboard.
		await journey.press('v');
		await journey.expectState(toggle, { expanded: true });
		await journey.expectFocused(words);
		await journey.type(
			'The discount reads well, but the codes belong in settings before this ships to the shop.'
		);
		await journey.press('Enter');
		await journey.press('Enter');
		await journey.type('Totals look right.');
		await journey.expectVisible(bar.byText('Not saved', { exact: true }));
		await journey.step('Writing the overall review');

		// Saved with Control+Enter, as a comment is; Escape then puts the bar away.
		await journey.press('Control+Enter');
		await journey.expectHidden(bar.byText('Not saved', { exact: true }));
		await journey.press('Escape');
		await journey.expectState(toggle, { expanded: false });
		await journey.expectFocused(toggle);
		await journey.expectVisible(
			bar.byText(
				'The discount reads well, but the codes belong in settings before this ships to the shop…',
				{ exact: true }
			)
		);
		await journey.step('Put away, it shows its first words');

		// A comment on a line: the bar counts it.
		const discount = journey.within(journey.byRole('article', { name: 'src/discount.ts' }));
		await journey.activate(
			discount.byRole('button', { name: 'Comment on line 1, after', exact: true })
		);
		const box = journey.within(
			journey.byRole('form', { name: 'New comment on After, line 1', exact: true })
		);
		await journey.expectFocused(box.byRole('textbox', { name: 'Comment', exact: true }));
		await journey.type('Read the codes from settings.');
		await journey.expectVisible(bar.byText('1 comment being written', { exact: true }));
		await journey.activate(box.byRole('button', { name: 'Save comment', exact: true }));
		await journey.expectVisible(bar.byText('1 comment', { exact: true }));
		await journey.step('The bar counts the comment');

		// `v` again: the box, with the saved words, to change them.
		await journey.press('v');
		await journey.expectFocused(words);
		await journey.press('Control+End');
		await journey.type(' Ship it once the codes move.');
		await journey.activate(save);
		await journey.expectHidden(bar.byText('Not saved', { exact: true }));
		await journey.expectState(words, {
			value:
				'The discount reads well, but the codes belong in settings before this ships to the shop.\n\nTotals look right. Ship it once the codes move.'
		});
		await journey.step('The overall review changed');

		// From the bar to Finish and copy, which finishes both and copies them.
		await journey.activate(bar.byRole('button', { name: 'Finish your review', exact: true }));
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		const finishAndCopy = finish.byRole('button', { name: 'Finish and copy', exact: true });
		await journey.expectFocused(finishAndCopy);
		await journey.expectVisible(
			finish.byText('Finishing makes your overall review and 1 comment review 1.', {
				exact: false
			})
		);
		await journey.step('From the bar to Finish and copy');

		await journey.activate(finishAndCopy);
		await journey.expectVisible(
			finish.byText('Review 1 is finished and copied.', { exact: false })
		);
		const copied = await journey.readClipboard();
		const overall = copied.indexOf(
			[
				'## Overall',
				'',
				'> The discount reads well, but the codes belong in settings before this ships to the shop.',
				'>',
				'> Totals look right. Ship it once the codes move.',
				'',
				'## Comments',
				''
			].join('\n')
		);
		expect(overall).toBeGreaterThan(0);
		expect(copied.slice(0, overall)).not.toContain('### ');
		expect(copied).toContain('> Read the codes from settings.');
		// The draft is empty again, its overall review too.
		await journey.expectState(words, { value: '' });
		await journey.expectVisible(bar.byText('No comments yet', { exact: true }));
		await journey.expectVisible(
			finish.byText('Review 1: an overall review and 1 comment, finished', { exact: false })
		);
		await journey.step('The review finished, its overall review first');
	});
});
