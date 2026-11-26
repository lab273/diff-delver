import { test } from '../support/journey.ts';

// J16 Reading and finding: code to read, coloured by language, with its marks
// over the colours, and plain when asked; side by side; with changes to white
// space hidden; then searching the whole diff, from match to match, with its
// options, into a file that was closed, and back to where the reader was.
test.describe('J16 Reading and finding', () => {
	test('the reviewer reads code coloured, side by side and without white-space changes, and searches it', async ({
		journey
	}) => {
		// Code is coloured by language, each file as a whole: a line deep inside a
		// comment is coloured as a comment though the line that opens it is hidden.
		const reading = await journey.repository('reading');
		await journey.open((await journey.command([], reading)).address);
		const lexer = journey.byRole('article', { name: 'src/lexer.ts' });
		await journey.expectVisible(journey.within(lexer).byText('8 unchanged lines'));
		await journey.expectVisible(
			journey.within(lexer).byText(' *   4. A number is a word, and keeps its digits.')
		);
		await journey.expectVisible(journey.byRole('article', { name: 'app/models.py' }));
		await journey.step('Code coloured by language');

		// Rust and CSS too; and the marks for a tab, white space at the end, a CRLF
		// ending and a character that cannot be seen are drawn over the colours.
		for (let n = 0; n < 4; n += 1) await journey.press('j');
		const marks = journey.byRole('article', { name: 'src/marks.ts' });
		await journey.expectFocused(journey.byRole('button', { name: 'src/marks.ts', exact: true }));
		await journey.expectVisible(journey.within(marks).byText('\\u200B'));
		await journey.step('Marks over colours');

		// Colours can be switched off, for every diff; the code is then plain.
		const colours = journey.byRole('button', { name: 'Colour the code' });
		await journey.activate(colours);
		await journey.expectState(colours, { pressed: false });
		await journey.step('Code shown plain');
		await journey.activate(colours);
		await journey.expectState(colours, { pressed: true });

		// Side by side: before on the left, after on the right, a removed run beside
		// the added run that replaces it, a line with nothing in its place beside an
		// empty cell, and unchanged lines opened across both sides.
		await journey.press('s');
		await journey.expectState(journey.byRole('button', { name: 'Side by side' }), {
			pressed: true
		});
		await journey.tabTo(journey.byRole('button', { name: 'src/pairs.ts', exact: true }));
		const pairs = journey.byRole('article', { name: 'src/pairs.ts' });
		await journey.expectFocused(journey.byRole('button', { name: 'src/pairs.ts', exact: true }));
		await journey.expectVisible(
			journey.within(pairs).byRole('table', { name: 'Lines side by side of src/pairs.ts' })
		);
		await journey.activate(
			journey.within(pairs).byRole('button', { name: 'Show all 7 unchanged lines' })
		);
		// An unchanged line opened is on both sides.
		const price13 = journey.within(pairs).byText('export const price13 = 130;');
		await journey.expectVisible(journey.nth(price13, 1));
		await journey.expectVisible(journey.nth(price13, 2));
		await journey.step('Side by side');
		// Back to one column, from the keyboard: the reader stays on the same file.
		await journey.press('s');
		await journey.expectVisible(
			journey.within(pairs).byRole('table', { name: 'Lines of src/pairs.ts' })
		);
		await journey.expectInView(journey.byRole('button', { name: 'src/pairs.ts', exact: true }));

		// White-space changes hidden: a re-indented block reads as unchanged lines
		// among the real change, a hunk with nothing else says so, and the file says
		// how many are hidden and that marking it reviewed covers them.
		await journey.press('w');
		await journey.expectState(journey.byRole('button', { name: 'Hide white-space changes' }), {
			pressed: true
		});
		await journey.press('j');
		await journey.press('j');
		const total = journey.byRole('article', { name: 'tools/total.ts' });
		await journey.expectFocused(journey.byRole('button', { name: 'tools/total.ts', exact: true }));
		await journey.expectText(
			total,
			'10 changes here only change white space, so they are drawn as unchanged lines. Marking this file as reviewed covers them too.'
		);
		await journey.expectText(total, 'Only white space changed here: 2 changes hidden');
		await journey.step('White-space changes hidden');

		// Side by side too: each side keeps its own white space.
		await journey.press('s');
		await journey.expectVisible(
			journey.within(total).byRole('table', { name: 'Lines side by side of tools/total.ts' })
		);
		await journey.step('White-space changes hidden side by side');

		// They are still changes: ticking the file marks all twelve, and r goes on to the next.
		await journey.press('r');
		await journey.expectState(
			journey.within(total).byRole('checkbox', { name: 'Reviewed: tools/total.ts' }),
			{ checked: true }
		);
		await journey.expectText(
			journey.byRole('complementary', { name: 'Your review' }),
			'12 of 40 changes reviewed'
		);

		// Where white space is part of what a file says, as in YAML, the file says
		// so: its hidden change moves a key out of its block.
		const workflow = journey.byRole('article', { name: 'tools/workflow.yml' });
		await journey.expectFocused(
			journey.byRole('button', { name: 'tools/workflow.yml', exact: true })
		);
		await journey.expectText(
			workflow,
			'In a YAML file, white space can change what a line means, so they are worth a look.'
		);
		await journey.step('White space that matters, hidden');

		// Searching the diff: every file, not only those drawn. Typing counts and
		// marks the matches and moves nothing.
		await journey.press('s');
		await journey.press('w');
		await journey.press('/');
		const searchBox = journey.byRole('searchbox', { name: 'Search the diff' });
		await journey.expectFocused(searchBox);
		await journey.type('total');
		const search = journey.byRole('search', { name: 'Search the diff' });
		const found = journey.within(search).byRole('status');
		await journey.expectText(found, '13 matches in 2 files. Press Enter to go to the first.');
		await journey.step('A search across the diff');

		// Enter goes from match to match, Shift+Enter back; focus stays in the box.
		await journey.press('Enter');
		await journey.expectText(found, '1 of 13 matches in 2 files');
		await journey.press('Enter');
		await journey.expectText(found, '2 of 13 matches in 2 files');
		await journey.expectFocused(searchBox);
		await journey.step('Moving between matches');
		await journey.press('Shift+Enter');
		await journey.expectText(found, '1 of 13 matches in 2 files');

		// Its options are switches, remembered: with Match case, "Total" no longer matches.
		const matchCase = journey.within(search).byRole('button', { name: 'Match case' });
		await journey.activate(matchCase);
		await journey.expectState(matchCase, { pressed: true });
		await journey.expectText(found, '11 matches in 2 files');
		await journey.step('Searching with Match case');
		await journey.activate(matchCase);
		await journey.expectState(matchCase, { pressed: false });

		// Changed lines only: unchanged lines are not read, only added and removed
		// ones, and paths. Skip closed files: tools/total.ts, reviewed and so
		// closed, is passed over.
		const changedOnly = journey.within(search).byRole('button', { name: 'Changed lines only' });
		await journey.activate(changedOnly);
		await journey.expectState(changedOnly, { pressed: true });
		await journey.expectText(found, '6 matches in 2 files');
		const skipClosed = journey.within(search).byRole('button', { name: 'Skip closed files' });
		await journey.activate(skipClosed);
		await journey.expectState(skipClosed, { pressed: true });
		await journey.expectText(found, '3 matches in 1 file');
		await journey.step('Searching changed lines of open files');
		await journey.activate(changedOnly);
		await journey.activate(skipClosed);
		await journey.expectState(skipClosed, { pressed: false });
		await journey.expectText(found, '13 matches in 2 files');

		// A match in a file that is closed, as a reviewed one is, opens it. The
		// search key, pressed again, selects what is in the box, to type over it.
		await journey.press('/');
		await journey.expectFocused(searchBox);
		await journey.type('Math.round');
		await journey.expectText(found, '1 match in 1 file. Press Enter to go to the first.');
		await journey.press('Enter');
		await journey.expectText(found, '1 of 1 match in 1 file');
		const totalToggle = journey.byRole('button', { name: 'tools/total.ts', exact: true });
		await journey.expectState(totalToggle, { expanded: true });
		await journey.expectInView(journey.within(total).byText('Math.round', { exact: false }));
		await journey.step('A match in a closed file');

		// Escape closes the search and puts the page back as it was: the file closed
		// again, and focus where it was.
		await journey.press('Escape');
		await journey.expectHidden(search);
		await journey.expectState(totalToggle, { expanded: false });
		await journey.expectFocused(
			journey.byRole('button', { name: 'tools/workflow.yml', exact: true })
		);
		await journey.step('The search closed');

		// Side by side, with white-space changes hidden, matches are marked on both
		// sides, and moving to one brings it to the middle of the screen.
		await journey.press('s');
		await journey.press('w');
		await journey.press('/');
		await journey.type('sum');
		await journey.expectText(found, '6 matches in 1 file. Press Enter to go to the first.');
		await journey.press('Enter');
		await journey.expectText(found, '1 of 6 matches in 1 file');
		await journey.expectInView(
			journey.nth(journey.within(total).byText('let sum = 0;', { exact: false }), 1)
		);
		await journey.press('Shift+Enter');
		await journey.expectText(found, '6 of 6 matches in 1 file');
		await journey.expectInView(journey.within(total).byText('Math.round', { exact: false }));
		await journey.step('A search side by side');
		// A match far up the page, on the side before the change, is brought into view.
		await journey.press('Escape');
		await journey.press('/');
		await journey.type('Numbers are words');
		await journey.expectText(found, '1 match in 1 file. Press Enter to go to the first.');
		await journey.press('Enter');
		await journey.expectText(found, '1 of 1 match in 1 file');
		await journey.expectInView(journey.within(lexer).byText('Numbers are words', { exact: false }));
		await journey.step('A removed line matched side by side');

		// The files change while the search is open. After an update it stays open,
		// with what is in the box, searched again in the new version.
		await journey.editFile(reading, 'notes/words.md', 'Numbers are words, as the lexer says.\n');
		await journey.returnToPage();
		const changed = journey.byRole('region', { name: 'Your files have changed' });
		await journey.activate(journey.within(changed).byRole('button', { name: 'Update' }));
		const updated = journey.byRole('heading', { name: 'Updated to version 2 just now' });
		await journey.expectFocused(updated);
		await journey.expectText(found, '2 matches in 2 files. Press Enter to go to the first.');
		await journey.step('A search kept through an update');
		// Moving to a match and closing the search brings the reader back to where
		// they were in this version, and focus to where it was.
		await journey.press('/');
		await journey.expectFocused(searchBox);
		await journey.press('Enter');
		await journey.expectText(found, '1 of 2 matches in 2 files');
		await journey.expectInView(
			journey
				.within(journey.byRole('article', { name: 'notes/words.md' }))
				.byText('Numbers are words', { exact: false })
		);
		await journey.press('Escape');
		await journey.expectHidden(search);
		await journey.expectInView(updated);
		await journey.expectFocused(updated);

		// Bookmark the code in view, then expand context, move away and search.
		const pairsToggle = journey.byRole('button', { name: 'src/pairs.ts', exact: true });
		await journey.tabTo(pairsToggle);
		await journey.press('o');
		await journey.press('o');
		const savedRow = journey.within(pairs).byRole('row', { name: /export const price2 = 20;/ });
		await journey.expectInView(savedRow);
		await journey.press('b');
		const bookmark = journey.byRole('button', { name: 'Return to bookmark src/pairs.ts' });
		await journey.expectVisible(bookmark);
		await journey.step('A bookmarked reading place');

		await journey.activate(
			journey.within(pairs).byRole('button', { name: 'Show all 7 unchanged lines' })
		);
		await journey.expectVisible(journey.nth(price13, 1));
		await journey.press('j');
		await journey.press('/');
		await journey.type('Math.round');
		await journey.expectText(found, '1 match in 1 file. Press Enter to go to the first.');
		await journey.press('Enter');
		await journey.expectInView(journey.within(total).byText('Math.round', { exact: false }));
		await journey.activate(bookmark);
		await journey.expectHidden(search);
		await journey.expectFocused(savedRow);
		await journey.expectInView(savedRow);
		await journey.step('Returned from search to the bookmarked line');

		// A fresh page in the same tab keeps the bookmark, even with a different layout.
		await journey.open(await journey.address());
		await journey.expectVisible(bookmark);
		await journey.press('s');
		await journey.press('Shift+KeyB');
		await journey.expectFocused(savedRow);
		await journey.expectVisible(
			journey.within(pairs).byRole('table', { name: 'Lines of src/pairs.ts' })
		);
		await journey.expectInView(savedRow);
		await journey.step('The bookmark after reopening the page');

		await journey.press('t');
		const filename = journey.byRole('combobox', { name: 'File name or path' });
		await journey.expectFocused(filename);
		await journey.type('fmtprc');
		await journey.expectVisible(journey.byRole('option', { name: 'src/format-price.ts' }));
		await journey.step('A fuzzy filename match');
		await journey.press('Enter');
		const unchanged = journey.byRole('dialog', { name: 'src/format-price.ts' });
		await journey.expectVisible(unchanged);
		await journey.expectText(unchanged, 'This file is unchanged in this diff.');
		await journey.expectText(unchanged, 'price.toFixed(2)');
		await journey.step('An unchanged file from the snapshot');
		await journey.back();
		await journey.expectHidden(unchanged);
		await journey.expectFocused(savedRow);
		await journey.expectInView(savedRow);

		await journey.activate(journey.byRole('button', { name: 'Open file' }));
		await journey.expectFocused(filename);
		await journey.type('lexer');
		await journey.expectVisible(journey.byRole('option', { name: 'src/lexer.ts Changed' }));
		await journey.press('Enter');
		const reader = journey.byRole('dialog', { name: 'src/lexer.ts' });
		const gutter = journey
			.within(reader)
			.byRole('button', { name: 'Show change at line 12 in the diff' });
		await journey.expectVisible(gutter);
		await journey.step('A changed file with a change in the margin');
		await journey.activate(journey.within(reader).byRole('button', { name: 'Show base' }));
		await journey.expectText(reader, 'Numbers are words too.');
		await journey.step('The same file before the change');
		await journey.activate(gutter);
		await journey.expectHidden(reader);
		const oldLine = journey.within(lexer).byRole('row', { name: /Numbers are words too/ });
		await journey.expectFocused(oldLine);
		await journey.expectInView(oldLine);
		await journey.expectVisible(bookmark);
		await journey.press('Shift+KeyB');
		await journey.expectFocused(savedRow);

		// Reading on with the keyboard, the reviewer marks each file with r as they
		// finish it, even while diff delver is slow to answer. Opening the shortcuts
		// while a file is being marked keeps the page where it is under them: the
		// file is marked, and the press made meanwhile is dropped, so nothing moves
		// or is marked behind the dialog.
		const nameOf = (path: string): ReturnType<typeof journey.byRole> =>
			journey.byRole('button', { name: path, exact: true });
		const tickOf = (path: string): ReturnType<typeof journey.byRole> =>
			journey.byRole('checkbox', { name: `Reviewed: ${path}` });
		const shortcuts = journey.byRole('dialog', { name: 'Keyboard shortcuts' });
		const marking = await journey.holdTick();
		await journey.press('r');
		await marking.requested;
		await journey.press('r');
		await journey.press('?');
		marking.release();
		await journey.expectState(tickOf('src/pairs.ts'), { checked: true });
		await journey.expectFocused(journey.within(shortcuts).byRole('button', { name: 'Close' }));
		await journey.step('The shortcuts opened while a file was being marked');
		await journey.press('Escape');
		await journey.expectHidden(shortcuts);
		await journey.expectFocused(nameOf('src/pairs.ts'));
		await journey.expectState(tickOf('styles/site.css'), { checked: false });

		// Moving while a file is being marked wins: r does not go on from where the
		// reader went, and the press made after the move acts there at once, without
		// waiting for the file being marked: on a file already reviewed, it only goes on.
		await journey.press('k');
		await journey.expectFocused(nameOf('src/marks.ts'));
		const moving = await journey.holdTick();
		await journey.press('r');
		await moving.requested;
		await journey.press('j');
		await journey.press('r');
		moving.release();
		await journey.expectState(tickOf('src/marks.ts'), { checked: true });
		await journey.expectVisible(
			journey.byText(/^src\/marks\.ts marked as reviewed\..* 25 of 41 changes reviewed\.$/)
		);
		await journey.expectFocused(nameOf('styles/site.css'));
		await journey.expectState(tickOf('styles/site.css'), { checked: false });
		await journey.step('Moved on while a file was being marked');

		// Going back while a file is being marked drops the presses of r made before
		// going back: the file is marked, and nothing is marked where they went.
		await journey.press('k');
		await journey.press('k');
		await journey.press('k');
		await journey.expectFocused(nameOf('src/main.rs'));
		const goingBack = await journey.holdTick();
		await journey.press('r');
		await goingBack.requested;
		await journey.press('r');
		await journey.press('k');
		goingBack.release();
		await journey.expectState(tickOf('src/main.rs'), { checked: true });
		await journey.expectFocused(nameOf('src/lexer.ts'));
		await journey.expectState(tickOf('src/lexer.ts'), { checked: false });
		await journey.step('Went back while a file was being marked');

		// A file slow to be marked holds nothing up: once the reviewer has moved, r
		// marks the file they moved to at once, and goes on to the next one waiting,
		// here the file still being marked, which is marked when its answer comes.
		const slow = await journey.holdTick();
		await journey.press('r');
		await slow.requested;
		await journey.press('k');
		await journey.expectFocused(nameOf('notes/words.md'));
		await journey.press('r');
		await journey.expectState(tickOf('notes/words.md'), { checked: true });
		await journey.expectFocused(nameOf('src/lexer.ts'));
		await journey.expectState(tickOf('src/lexer.ts'), { checked: false });
		slow.release();
		await journey.expectState(tickOf('src/lexer.ts'), { checked: true });
		await journey.expectFocused(nameOf('src/lexer.ts'));

		// Pressed twice quickly, r puts each file away as it marks it, though the
		// second press came before the first file was marked, and marks the next.
		await journey.press('n');
		await journey.expectFocused(nameOf('styles/site.css'));
		await journey.expectCollapse(nameOf('styles/site.css'), 'no-preference', async () => {
			const twice = await journey.holdTick();
			await journey.press('r');
			await twice.requested;
			await journey.press('r');
			twice.release();
		});
		await journey.expectState(tickOf('styles/site.css'), { checked: true });
		await journey.expectState(tickOf('tools/workflow.yml'), { checked: true });
		await journey.expectFocused(nameOf('app/models.py'));
	});
});
