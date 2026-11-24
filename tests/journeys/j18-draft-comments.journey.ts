import { test } from '../support/journey.ts';

test.describe('J18 Draft comments', () => {
	test('the reviewer comments from a line, sees each comment at its lines, and loses nothing to an update', async ({
		journey
	}) => {
		const reading = await journey.repository('reading');

		// A coding agent opened the Delve and gave its link: enough to read and tick.
		await journey.open(await journey.agentLink(reading));
		const off = journey.within(
			journey.byRole('region', { name: 'Comments are off in this browser' })
		);
		await journey.expectVisible(off.byText('You came here by a link'));
		await journey.expectHidden(journey.byRole('button', { name: /^Draft comments/ }));
		await journey.step('Comments are off after an agent’s link');

		// One press: diff delver opens the Delve in a window of its own making.
		await journey.activate(off.byRole('button', { name: 'Turn on comments in this browser' }));
		await journey.expectVisible(off.byText('A new tab has opened with comments turned on.'));
		await journey.inAnotherTab(await journey.openedWindow(), async (tab) => {
			await tab.expectVisible(tab.byRole('button', { name: 'Draft comments (0)', exact: true }));
			await tab.step('The tab diff delver opened');
		});
		await journey.returnToPage();
		await journey.expectVisible(journey.byText('Comments are on in this browser now.'));
		await journey.expectFocused(journey.byRole('button', { name: 'Draft comments (0)' }));
		await journey.step('Comments turned on with one press');

		const lexer = journey.byRole('article', { name: 'src/lexer.ts' });
		const file = journey.within(lexer);
		const toggle = file.byRole('button', { name: 'src/lexer.ts', exact: true });
		const expand = file.byRole('button', { name: 'Show all 8 unchanged lines above' });
		const line = (number: number, side: 'before' | 'after') =>
			file.byRole('button', { name: `Comment on line ${String(number)}, ${side}`, exact: true });
		const reviewed = file.byRole('checkbox', { name: 'Reviewed: src/lexer.ts' });
		const unreadOnly = journey.byRole('button', { name: 'Only what I have not reviewed' });
		const box = (name: string) => {
			const form = journey.within(journey.byRole('form', { name, exact: true }));
			return {
				form,
				words: form.byRole('textbox', { name: 'Comment', exact: true }),
				save: form.byRole('button', { name: 'Save comment', exact: true })
			};
		};

		// From a file, `c` goes to its lines; the arrow keys move, Shift with them takes several.
		await journey.activate(expand);
		await journey.expectVisible(line(1, 'after'));
		await journey.press('c');
		await journey.expectFocused(line(1, 'after'));
		await journey.press('ArrowLeft');
		await journey.expectFocused(line(1, 'before'));
		await journey.press('Shift+ArrowDown');
		await journey.expectFocused(line(2, 'before'));
		await journey.expectState(line(1, 'before'), { pressed: true });
		await journey.expectState(line(2, 'before'), { pressed: true });
		await journey.step('Two lines taken with the keyboard');

		// `c` on a line opens the box under it, for the lines taken.
		await journey.press('c');
		const first = box('New comment on Before, lines 1–2');
		await journey.expectFocused(first.words);
		await journey.type('Can we shorten this introduction?');
		await journey.step('Writing a comment under its lines');

		// Its lines put away, the box waits in the list of comments with what was typed.
		await journey.activate(toggle);
		await journey.expectState(toggle, { expanded: false });
		const waiting = box('New comment on src/lexer.ts, Before, lines 1–2');
		await journey.expectVisible(waiting.form.byText('Its lines are not on the page now'));
		await journey.activate(reviewed, 'Space');
		await journey.activate(unreadOnly);
		await journey.expectState(unreadOnly, { pressed: true });
		await journey.expectHidden(lexer);
		await journey.activate(waiting.save);
		await journey.expectVisible(journey.byRole('button', { name: 'Draft comments (1)' }));

		// Saved, it is shown at its lines.
		await journey.activate(unreadOnly);
		await journey.activate(reviewed, 'Space');
		await journey.expectState(toggle, { expanded: true });
		const saved = journey.within(
			file.byRole('article', { name: 'Your comment on Before, lines 1–2' })
		);
		await journey.expectVisible(saved.byText('Can we shorten this introduction?'));
		await journey.expectVisible(saved.byText('written just now'));
		await journey.step('The comment shown at its lines');

		// One line: `c` to the lines, `c` again on the line.
		await journey.press('c');
		await journey.expectFocused(line(1, 'after'));
		await journey.press('c');
		const second = box('New comment on After, line 1');
		await journey.expectFocused(second.words);
		await journey.type('Keep the heading on the after side.');

		// Another command brings the Delve up to date while this tab still shows version 1.
		await journey.editFile(reading, 'src/comment-follow-up.ts', 'export const heading = "Shop";\n');
		const newer = await journey.command([], reading);
		await journey.activate(second.save);
		await journey.expectText(second.form.byRole('alert'), 'updated to version 2');
		await journey.step('A stale save keeps the comment', {
			refusals: [{ route: '/api/diffs/[id]/comments', status: 409 }]
		});

		// On the new version it waits, with its words, for a line of that version.
		await journey.activate(
			second.form.byRole('button', { name: 'Show the new version', exact: true })
		);
		const moving = box('New comment on src/lexer.ts, After, line 1');
		await journey.expectVisible(moving.form.byText('These lines are in version 1'));
		await journey.expectState(moving.save, { disabled: true });
		await journey.expectState(moving.words, { value: 'Keep the heading on the after side.' });
		await journey.step('The comment waits for a line of the new version');

		await journey.press('s');
		await journey.activate(expand);
		await journey.expectVisible(line(1, 'after'));
		await journey.press('c');
		await journey.expectFocused(line(1, 'after'));
		await journey.press('c');
		await journey.expectFocused(second.words);
		await journey.expectState(second.words, { value: 'Keep the heading on the after side.' });
		await journey.activate(second.save);
		await journey.expectVisible(journey.byRole('button', { name: 'Draft comments (2)' }));
		await journey.expectVisible(
			journey
				.within(file.byRole('article', { name: 'Your comment on After, line 1' }))
				.byText('Keep the heading on the after side.')
		);
		await journey.step('Saved on the new version, side by side');

		// Every comment is listed, with the version an earlier one was written on.
		await journey.open(newer.address);
		const drafts = journey.byRole('button', { name: 'Draft comments (2)', exact: true });
		await journey.activate(drafts);
		const list = journey.within(journey.byRole('region', { name: 'Draft comments' }));
		const earlier = journey.within(
			list.byRole('article', { name: 'Your comment on src/lexer.ts, Before, lines 1–2' })
		);
		await journey.expectVisible(earlier.byText('Can we shorten this introduction?'));
		await journey.expectVisible(earlier.byText('Written on version 1, an earlier version'));
		await journey.expectVisible(
			journey
				.within(list.byRole('article', { name: 'Your comment on src/lexer.ts, After, line 1' }))
				.byText('Keep the heading on the after side.')
		);
		await journey.step('Draft comments after reopening');

		// Its lines are folded away again: the file says a comment is there, and the
		// list goes to it, opening the lines around it.
		await journey.expectVisible(file.byText('One of your comments is on these lines'));
		await journey.activate(
			list.byRole('button', { name: 'Go to its lines: src/lexer.ts, After, line 1', exact: true })
		);
		const there = file.byRole('article', { name: 'Your comment on After, line 1' });
		await journey.expectFocused(there);
		await journey.expectInView(there);
		await journey.expectHidden(file.byText('One of your comments is on these lines'));
		await journey.step('Gone from the list to a comment');

		// A comment begun and not wanted is discarded, and the keyboard is back on its line.
		await journey.press('c');
		await journey.expectFocused(line(1, 'after'));
		await journey.press('c');
		await journey.expectFocused(second.words);
		await journey.type('Discard this text.');
		await journey.activate(second.form.byRole('button', { name: 'Discard', exact: true }));
		await journey.expectHidden(journey.byText('Discard this text.'));
		await journey.expectFocused(line(1, 'after'));
	});
});
