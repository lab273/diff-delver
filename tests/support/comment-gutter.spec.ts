import { expect, test } from '@playwright/test';
import { absolutePath, GitRepo } from './git-repo.ts';
import { makeJourneyWorld } from './journey-world.ts';

// Journeys drive the keyboard. The pointer, and a browser let in by a link, are exercised here.
test('pressing a line number opens the comment box under it, and dragging takes a range on that side', async ({
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
			file.getByRole('button', { name: `Comment on line ${String(number)}, ${side}`, exact: true });
		const middle = async (target: ReturnType<typeof line>) => {
			await target.scrollIntoViewIfNeeded();
			const box = await target.boundingBox();
			if (box === null) throw new Error('The line number must be drawn');
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		};

		// One press: the box opens under that line, and takes the keyboard.
		await line(4, 'after').click();
		const one = page.getByRole('form', { name: 'New comment on After, line 4', exact: true });
		await expect(one.getByRole('textbox', { name: 'Comment' })).toBeFocused();
		await expect(line(4, 'after')).toHaveAttribute('aria-pressed', 'true');
		// The same line again goes back to the box that is there, and makes no second one.
		await line(4, 'after').click();
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

		// Shift with a press takes the lines from where the keyboard was to there.
		await line(6, 'after').focus();
		await line(8, 'after').click({ modifiers: ['Shift'] });
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
		const line = file.getByRole('button', { name: 'Comment on line 2, after', exact: true });
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
		const first = file.getByRole('button', { name: 'Comment on line 1, before', exact: true });
		const far = file.getByRole('button', { name: 'Comment on line 1, after', exact: true });
		const middle = file.getByRole('button', { name: 'Comment on line 10000, before', exact: true });
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
			file.getByRole('button', { name: 'Comment on line 40000, before', exact: true })
		).toBeFocused();
		await expect(middle).toHaveCount(0);
	} finally {
		await world.close();
	}
});
