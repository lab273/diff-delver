import { expect, test } from '@playwright/test';
import { absolutePath, GitRepo } from './git-repo.ts';
import { makeJourneyWorld } from './journey-world.ts';

// Journeys drive the keyboard. The pointer, and a browser let in by a link, are exercised here.
test('pressing a line number opens the menu under it, Comment or Flag, and dragging takes a range on that side', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		await page.goto((await world.command([], repo)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const file = page.getByRole('article', { name: 'src/lexer.ts' });
		await file.getByRole('button', { name: 'Show all 8 unchanged lines above' }).click();
		const line = (number: number, side: 'before' | 'after') =>
			file.getByRole('button', {
				name: `Comment on or flag line ${String(number)}, ${side}`,
				exact: true
			});
		const middle = async (target: ReturnType<typeof line>) => {
			await target.scrollIntoViewIfNeeded();
			const box = await target.boundingBox();
			if (box === null) throw new Error('The line number must be drawn');
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		};

		// One press: the menu opens under that line, Comment or Flag.
		const choose = async (words: string, kind: 'Comment on' | 'Flag') => {
			const button = file.getByRole('button', {
				name: kind === 'Flag' ? `Flag ${words} to look at again` : `Comment on ${words}`,
				exact: true
			});
			await expect(
				file.getByRole('button', { name: `Comment on ${words}`, exact: true })
			).toBeFocused();
			await button.click();
		};
		await line(4, 'after').click();
		await choose('After, line 4', 'Comment on');
		const one = page.getByRole('form', { name: 'New comment on After, line 4', exact: true });
		await expect(one.getByRole('textbox', { name: 'Comment' })).toBeFocused();
		await expect(line(4, 'after')).toHaveAttribute('aria-pressed', 'true');
		// The same line again goes back to the box that is there, and makes no second one.
		await line(4, 'after').click();
		await choose('After, line 4', 'Comment on');
		await expect(page.getByRole('form', { name: /^New comment/ })).toHaveCount(1);
		await one.getByRole('button', { name: 'Discard', exact: true }).click();
		await expect(one).toHaveCount(0);
		await expect(line(4, 'after')).not.toHaveAttribute('aria-pressed', 'true');

		// A drag over the numbers of one side takes the lines between.
		const from = await middle(line(1, 'before'));
		const to = await middle(line(3, 'before'));
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y, { steps: 5 });
		for (const number of [1, 2, 3]) {
			await expect(line(number, 'before')).toHaveAttribute('aria-pressed', 'true');
		}
		await expect(line(2, 'after')).not.toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByRole('form', { name: /^New comment/ })).toHaveCount(0);
		await page.mouse.up();
		await choose('Before, lines 1–3', 'Comment on');
		const range = page.getByRole('form', { name: 'New comment on Before, lines 1–3', exact: true });
		await expect(range.getByRole('textbox', { name: 'Comment' })).toBeFocused();
		await expect(page.getByRole('form', { name: /^New comment/ })).toHaveCount(1);
		// Only one number in the file is a stop for Tab.
		await expect(file.locator('button.pick-line[tabindex="0"]')).toHaveCount(1);
		await range.getByRole('textbox', { name: 'Comment' }).fill('Three lines.');
		await range.getByRole('button', { name: 'Save comment', exact: true }).click();
		const saved = file.getByRole('article', { name: 'Your comment on Before, lines 1–3' });
		await expect(saved).toContainText('Three lines.');
		// It is drawn under the last of its lines.
		const lastRow = await line(3, 'before').boundingBox();
		const comment = await saved.boundingBox();
		const nextRow = await line(4, 'before').boundingBox();
		if (lastRow === null || comment === null || nextRow === null) throw new Error('not drawn');
		expect(comment.y).toBeGreaterThan(lastRow.y);
		expect(comment.y).toBeLessThan(nextRow.y);

		// Flag, from the menu: saved at once, drawn under its line, and the keyboard back on it.
		await line(5, 'after').click();
		await choose('After, line 5', 'Flag');
		await expect(file.getByRole('article', { name: 'Your flag on After, line 5' })).toBeVisible();
		await expect(line(5, 'after')).toBeFocused();

		// Shift with a press takes the lines from where the keyboard was to there.
		await line(6, 'after').focus();
		await line(8, 'after').click({ modifiers: ['Shift'] });
		await choose('After, lines 6–8', 'Comment on');
		const unsaved = page.getByRole('form', {
			name: 'New comment on After, lines 6–8',
			exact: true
		});
		await expect(unsaved).toBeVisible();

		// A comment being written among the lines is listed above the diff, with the way back to it.
		const list = page.getByRole('region', { name: 'Draft comments' });
		await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
		await list.getByRole('button', { name: 'Draft comments (1)' }).focus();
		const waiting = list.getByRole('list', { name: 'Comments not saved yet' });
		await expect(waiting).toContainText('Not saved yet: src/lexer.ts After, lines 6–8');
		await waiting
			.getByRole('button', {
				name: 'Go to the comment you are writing: src/lexer.ts, After, lines 6–8'
			})
			.click();
		await expect(unsaved.getByRole('textbox', { name: 'Comment' })).toBeFocused();
		await expect(unsaved).toBeInViewport();

		// With nothing typed the page can be left; with words not saved, the browser asks first.
		await unsaved.getByRole('textbox', { name: 'Comment' }).fill('Not saved yet.');
		const question = page.waitForEvent('dialog');
		void page.evaluate(() => {
			location.reload();
		});
		const dialog = await question;
		expect(dialog.type()).toBe('beforeunload');
		await dialog.dismiss();
		await expect(unsaved.getByRole('textbox', { name: 'Comment' })).toHaveValue('Not saved yet.');
	} finally {
		await world.close();
	}
});

test('words typed in a box are kept when the page is left by its own links and come back to', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		await page.goto((await world.command([], repo)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const delve = page.url();
		const file = page.getByRole('article', { name: 'src/lexer.ts' });
		await file.getByRole('button', { name: 'Show all 8 unchanged lines above' }).click();
		await file
			.getByRole('button', { name: 'Comment on or flag line 2, after', exact: true })
			.click();
		await file.getByRole('button', { name: 'Comment on After, line 2', exact: true }).click();
		const typed = 'Kept through the list of Delves.';
		await page
			.getByRole('form', { name: 'New comment on After, line 2', exact: true })
			.getByRole('textbox', { name: 'Comment' })
			.fill(typed);
		// Back on the Delve its unchanged lines are folded again, so the box waits in the list.
		const waiting = page.getByRole('form', {
			name: 'New comment on src/lexer.ts, After, line 2',
			exact: true
		});
		const words = waiting.getByRole('textbox', { name: 'Comment' });
		const questions: string[] = [];
		page.on('dialog', (dialog) => {
			questions.push(dialog.type());
			void dialog.dismiss();
		});

		// To the list of Delves and back with the browser's Back.
		await page.getByRole('link', { name: 'See all your Delves' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Your Delves' })).toBeVisible();
		await expect(page.getByText('Something you were writing here is not saved yet.')).toBeVisible();
		await page.goBack();
		await expect(page).toHaveURL(delve);
		await expect(words).toHaveValue(typed);

		// By the link at the top of every page, and back by the Delve's own link in the list.
		await page.getByRole('link', { name: 'diff delver', exact: true }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Your Delves' })).toBeVisible();
		await page.getByRole('link', { name: 'Uncommitted changes' }).click();
		await expect(page).toHaveURL(delve);
		await expect(words).toHaveValue(typed);
		// None of that asked anything: nothing was at risk.
		expect(questions).toEqual([]);

		// Saved from where it waits, it is a comment, and nothing is left unsaved.
		await waiting.getByRole('button', { name: 'Save comment', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Draft comments (1)' })).toBeVisible();
		await page.getByRole('link', { name: 'See all your Delves' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Your Delves' })).toBeVisible();
		await expect(page.getByText('Something you were writing here is not saved yet.')).toHaveCount(
			0
		);
	} finally {
		await world.close();
	}
});

test('a comment is changed in one box, holds what was typed exactly, and shows what cannot be seen', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		await page.goto((await world.command([], repo)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const file = page.getByRole('article', { name: 'src/lexer.ts' });
		await file
			.getByRole('button', { name: 'Comment on or flag line 12, after', exact: true })
			.click();
		await file.getByRole('button', { name: 'Comment on After, line 12', exact: true }).click();
		const box = page.getByRole('form', { name: 'New comment on After, line 12', exact: true });
		const words = box.getByRole('textbox', { name: 'Comment' });
		const save = box.getByRole('button', { name: 'Save comment', exact: true });

		// A paste longer than a comment holds is not cut short: it is all there, and the box says so.
		await words.fill('x'.repeat(10_050));
		await expect(words).toHaveValue('x'.repeat(10_050));
		await expect(box.getByRole('status')).toHaveText(
			'50 characters too long: a comment holds up to 10,000. Shorten it to save.'
		);
		await expect(save).toHaveAttribute('aria-disabled', 'true');
		await words.fill('x'.repeat(10_001));
		await expect(box.getByRole('status')).toContainText('1 character too long');

		// Characters that are not seen, or turn text round, are written out where the
		// comment is drawn; a tab and a line break are drawn as they are.
		const typed = 'Is this safe\u202Etxt.exe?\n\tzero\u200Bwidth';
		await words.fill(typed);
		await expect(box.getByRole('status')).toHaveCount(0);
		await save.click();
		const saved = file.getByRole('article', { name: 'Your comment on After, line 12' });
		await expect(saved.locator('.words')).toHaveText(
			'Is this safe\\u202Etxt.exe?\n\tzero\\u200Bwidth',
			{
				useInnerText: true
			}
		);
		await expect(saved.locator('.escape')).toHaveText(['\\u202E', '\\u200B']);

		// With the list open the comment is drawn twice, and changed in one box: where Edit was pressed.
		await page.getByRole('button', { name: 'Draft comments (1)', exact: true }).click();
		const listed = page
			.getByRole('region', { name: 'Draft comments' })
			.getByRole('article', { name: 'Your comment on src/lexer.ts, After, line 12' });
		await saved.getByRole('button', { name: 'Edit your comment on After, line 12' }).click();
		const editing = page.getByRole('form', { name: /^Editing your comment/ });
		await expect(editing).toHaveCount(1);
		await expect(file.getByRole('form', { name: /^Editing your comment/ })).toHaveCount(1);
		// The words kept are exactly the ones typed.
		await expect(editing.getByRole('textbox', { name: 'Comment' })).toHaveValue(typed);
		await expect(listed).toContainText('You are changing its words under its lines, below.');
		// Edit pressed in the list brings the same box, with what it holds, there.
		await editing.getByRole('textbox', { name: 'Comment' }).fill('Half changed.');
		await listed
			.getByRole('button', { name: 'Edit your comment on src/lexer.ts, After, line 12' })
			.click();
		await expect(editing).toHaveCount(1);
		await expect(listed.getByRole('form', { name: /^Editing your comment/ })).toHaveCount(1);
		await expect(editing.getByRole('textbox', { name: 'Comment' })).toHaveValue('Half changed.');
		await expect(saved).toContainText('You are changing its words in the list of comments, above.');
		await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(editing).toHaveCount(0);
		await expect(saved.locator('.words')).toHaveText('Half changed.');
		await expect(listed.locator('.words')).toHaveText('Half changed.');
	} finally {
		await world.close();
	}
});

test('a browser let in by a link is told under the line how to turn comments on, and the box opens once it may', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		await page.goto(await world.agentLink(repo));
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const file = page.getByRole('article', { name: 'src/lexer.ts' });
		await file.getByRole('button', { name: 'Show all 8 unchanged lines above' }).click();
		const line = file.getByRole('button', {
			name: 'Comment on or flag line 2, after',
			exact: true
		});
		await line.click();
		const off = file.getByRole('region', { name: 'Comments are off in this browser' });
		await expect(off).toBeVisible();
		await expect(page.getByRole('form', { name: /^New comment/ })).toHaveCount(0);
		await expect(line).toHaveAttribute('aria-pressed', 'true');

		// Put away, it leaves the line as it was.
		await file.getByRole('button', { name: 'Not now', exact: true }).click();
		await expect(off).toHaveCount(0);
		await expect(line).toBeFocused();
		await expect(line).not.toHaveAttribute('aria-pressed', 'true');

		// Asked again and turned on: the comment that was asked for is started.
		await line.click();
		await off.getByRole('button', { name: 'Turn on comments in this browser' }).click();
		await expect(off.getByText('A new tab has opened with comments turned on.')).toBeVisible();
		const opened = world.openedWindow();
		if (opened === undefined) throw new Error('diff delver opened no window');
		// Pressed again at once, by the notice at the top of the page: no second window, and it says why.
		const top = page.getByRole('region', { name: 'Comments are off in this browser' }).first();
		await top.getByRole('button', { name: 'Turn on comments in this browser' }).click();
		await expect(top.getByText('A window was opened a moment ago.')).toBeVisible();
		expect(world.openedWindow()).toBeUndefined();
		const tab = await page.context().newPage();
		try {
			await tab.goto(opened);
			await expect(tab.getByRole('button', { name: 'Draft comments (0)' })).toBeVisible();
		} finally {
			await tab.close();
		}
		await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
		const box = page.getByRole('form', { name: 'New comment on After, line 2', exact: true });
		await expect(box.getByRole('textbox', { name: 'Comment' })).toBeFocused();
		await expect(off).toHaveCount(0);
	} finally {
		await world.close();
	}
});

test('a tab whose window opened in another browser says so when it is come back to', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		await page.goto(await world.agentLink(repo));
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const off = page.getByRole('region', { name: 'Comments are off in this browser' });
		await expect(off).toContainText(
			'This page was opened from a link, so you can read and tick here, but not comment yet. Press the button and diff delver opens this Delve in a window where you can.'
		);
		await off.getByRole('button', { name: 'Turn on comments in this browser' }).click();
		await expect(off.getByText('A new tab has opened with comments turned on.')).toBeVisible();
		// The window opened somewhere this browser never sees: coming back, comments are still off.
		expect(world.openedWindow()).toBeDefined();
		await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
		await expect(off.getByText('Still off in this tab?')).toBeVisible();
		await expect(off).toContainText('The new tab opens in your system’s default browser.');
		await expect(off.locator('code')).toHaveText(/ --no-open$/);
		await expect(off.getByRole('button', { name: 'Copy the command' })).toBeVisible();
	} finally {
		await world.close();
	}
});

test('horizontal navigation draws the far side of a long replacement without drawing the intervening chunks', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const directory = await world.repository('long-file');
		const repo = GitRepo.open(absolutePath(directory));
		await repo.write('data/rows.txt', 'new first line\nnew second line\n');
		await page.goto((await world.command([], directory)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const file = page.getByRole('article', { name: 'data/rows.txt' });
		await file.getByRole('button', { name: 'Show this large change' }).click();
		const first = file.getByRole('button', {
			name: 'Comment on or flag line 1, before',
			exact: true
		});
		const far = file.getByRole('button', { name: 'Comment on or flag line 1, after', exact: true });
		const middle = file.getByRole('button', {
			name: 'Comment on or flag line 10000, before',
			exact: true
		});
		await expect(first).toBeVisible();
		// `c` goes from the file to its lines, at the first one on the screen.
		await page.keyboard.press('c');
		await expect(first).toBeFocused();
		await expect(far).toHaveCount(0);
		await page.keyboard.press('ArrowRight');
		await expect(far).toBeFocused();
		await expect(middle).toHaveCount(0);
		await page.keyboard.press('ArrowLeft');
		await expect(
			file.getByRole('button', { name: 'Comment on or flag line 40000, before', exact: true })
		).toBeFocused();
		await expect(middle).toHaveCount(0);
	} finally {
		await world.close();
	}
});
