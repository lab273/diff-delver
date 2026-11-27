import { expect, test } from '../support/journey.ts';

// J6 Comment and flag: from a line, the same small menu offers Comment and
// Flag; `f` flags at once, on changed lines and on unchanged ones opened from
// the folded lines alike. A flag takes words if the reviewer wants, is cleared
// with one press, and is in the review finished, under its own heading.
// Keyboard only.
test.describe('J6 Comment and flag', () => {
	test('the reviewer flags lines, comments on a run of them, clears a flag and finishes with one', async ({
		journey
	}) => {
		const reading = await journey.repository('reading');
		await journey.open((await journey.command([], reading)).address);

		const file = journey.within(journey.byRole('article', { name: 'src/lexer.ts' }));
		const line = (number: number) =>
			file.byRole('button', {
				name: `Comment on, flag or ask about line ${String(number)}, after`,
				exact: true
			});
		const bar = journey.within(journey.byRole('region', { name: 'Your draft review' }));
		const list = bar.byRole('button', { name: 'Your draft review', exact: true });

		// `j` moves from file to file, to the lexer.
		await journey.press('j');
		await journey.expectFocused(journey.byRole('button', { name: 'app/models.py', exact: true }));
		await journey.press('j');
		await journey.expectFocused(file.byRole('button', { name: 'src/lexer.ts', exact: true }));

		// An unchanged line, opened from the folded lines: `c` goes to the lines, and a
		// line's number opens the menu.
		await journey.activate(file.byRole('button', { name: 'Show all 8 unchanged lines above' }));
		await journey.press('c');
		await journey.expectFocused(line(1));
		await journey.press('ArrowDown');
		await journey.expectFocused(line(2));
		await journey.press('Enter');
		const menu = journey.within(
			file.byRole('group', { name: 'After, line 2: comment, flag or ask' })
		);
		await journey.expectFocused(menu.byRole('button', { name: 'Comment on After, line 2' }));
		await journey.step('The menu under a line');

		// Leaving the menu puts it away, so it never holds up the agent's regroup.
		await journey.press('Shift+Tab');
		await journey.expectFocused(line(2));
		await journey.expectHidden(
			file.byRole('group', { name: 'After, line 2: comment, flag or ask' })
		);
		await journey.press('Enter');
		await journey.expectFocused(menu.byRole('button', { name: 'Comment on After, line 2' }));

		// Flag, in the menu: saved at once, and the keyboard is back on the line.
		await journey.press('Tab');
		await journey.press('Enter');
		const flagged = (number: number) =>
			journey.within(
				file.byRole('article', { name: `Your flag on After, line ${String(number)}` })
			);
		await journey.expectVisible(flagged(2).byText('Flagged to look at again'));
		await journey.expectFocused(line(2));
		await journey.expectVisible(bar.byText('1 flag', { exact: true }));
		await journey.step('A line flagged');

		// `f` again on the same line makes no second flag.
		await journey.press('f');
		await journey.expectVisible(bar.byText('1 flag', { exact: true }));

		// A comment on a run of lines, with `c`; then `f` flags the first line.
		await journey.press('Shift+ArrowDown');
		await journey.press('c');
		const box = journey.within(
			journey.byRole('form', { name: 'New comment on After, lines 2–3', exact: true })
		);
		await journey.expectFocused(box.byRole('textbox', { name: 'Comment', exact: true }));
		await journey.type('Say what the lexer does with tabs.');
		await journey.press('Control+Enter');
		await journey.expectFocused(line(3));
		await journey.press('ArrowUp');
		await journey.press('ArrowUp');
		await journey.expectFocused(line(1));
		await journey.press('f');
		await journey.expectVisible(flagged(1).byText('Flagged to look at again'));
		await journey.expectVisible(bar.byText('1 comment and 2 flags', { exact: true }));
		await journey.step('A comment and two flags');

		// `F` goes from the line the keyboard is on to each flag in reading order, then round.
		await journey.press('F');
		await journey.expectFocused(file.byRole('article', { name: 'Your flag on After, line 1' }));
		await journey.press('F');
		await journey.expectFocused(file.byRole('article', { name: 'Your flag on After, line 2' }));
		await journey.press('F');
		await journey.expectFocused(file.byRole('article', { name: 'Your flag on After, line 1' }));
		await journey.expectVisible(journey.byText('Back to the first flag.'));

		// A flag's words are added in place; the other is cleared with one press.
		await journey.activate(
			flagged(2).byRole('button', { name: 'Add words to your flag on After, line 2', exact: true })
		);
		const words = journey.within(
			file.byRole('form', { name: 'Words for your flag on After, line 2', exact: true })
		);
		await journey.expectFocused(
			words.byRole('textbox', { name: 'Why look again (optional)', exact: true })
		);
		await journey.type('Check this against the tokens in the parser.');
		await journey.press('Control+Enter');
		await journey.expectVisible(flagged(2).byText('Check this against the tokens in the parser.'));
		await journey.activate(
			flagged(1).byRole('button', { name: 'Clear your flag on After, line 1', exact: true })
		);
		await journey.expectHidden(file.byRole('article', { name: 'Your flag on After, line 1' }));
		await journey.expectFocused(line(1));
		await journey.expectVisible(bar.byText('1 comment and 1 flag', { exact: true }));
		await journey.step('A flag with words, the other cleared');

		// `F` goes to the next flag; the draft at the foot of the page lists it too.
		await journey.press('F');
		await journey.expectFocused(file.byRole('article', { name: 'Your flag on After, line 2' }));
		await journey.activate(list);
		await journey.expectVisible(
			journey.byRole('article', { name: 'Your flag on src/lexer.ts, After, line 2' })
		);
		await journey.step('The flag in the list of comments');

		// Finished, the flag is in the review copied, under its own heading.
		await journey.activate(bar.byRole('button', { name: 'Finish your review', exact: true }));
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		await journey.expectVisible(
			finish.byText('Finishing makes your 1 comment and 1 flag review 1.', { exact: false })
		);
		await journey.activate(finish.byRole('button', { name: 'Finish and copy', exact: true }));
		await journey.expectVisible(
			finish.byText('Review 1 is finished and copied.', { exact: false })
		);
		const copied = await journey.readClipboard();
		expect(copied).toContain(
			[
				'## Flagged for another look',
				'',
				'- src/lexer.ts:2 (new)',
				'  > Check this against the tokens in the parser.',
				'',
				'## Not reviewed'
			].join('\n')
		);
		expect(copied).toContain('### src/lexer.ts:2-3 (new)');
		await journey.expectVisible(
			finish.byText('Review 1: 1 comment and 1 flag, finished', { exact: false })
		);
		await journey.step('The review finished with its flag');
	});
});
