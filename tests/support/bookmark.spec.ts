import { expect, test } from '@playwright/test';
import { absolutePath, GitRepo } from './git-repo.ts';
import { makeJourneyWorld } from './journey-world.ts';

test.use({ viewport: { width: 420, height: 660 }, hasTouch: true });

// Journeys use the keyboard. Exercise the fixed reading controls with a touch screen.
test('bookmarks an expanded unchanged line by touch and restores a bounded window', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const directory = await world.repository('long-file');
		const repo = GitRepo.open(absolutePath(directory));
		const path = 'data/rows.txt';
		const context = Array.from({ length: 180 }, (_, i) => `context ${String(i + 1)}\n`).join('');
		await repo.write(path, `before first\n${context}before last\n`);
		await repo.commit('Put unchanged context between two changes');
		await repo.write(path, `after first\n${context}after last\n`);
		await page.goto((await world.command([], directory)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const file = page.getByRole('article', { name: path });
		const gap = file.getByRole('button', { name: 'Show all 174 unchanged lines' });
		await gap.tap();
		const row = file.getByRole('row', { name: /context 90$/ });
		await expect(row).toBeVisible();
		await row.evaluate((element) => {
			element.scrollIntoView({ block: 'start' });
			window.scrollBy(0, 1);
		});
		const save = page.getByRole('button', { name: 'Bookmark this spot' });
		await expect(save).toBeInViewport({ ratio: 1 });
		const before = await page.evaluate(() => window.scrollY);
		await save.tap();
		expect(await page.evaluate(() => window.scrollY)).toBe(before);

		await page.reload();
		const back = page.getByRole('button', { name: `Return to bookmark ${path}` });
		await expect(back).toBeInViewport({ ratio: 1 });
		await back.tap();
		await expect(row).toBeFocused();
		await expect(row).toBeInViewport({ ratio: 1 });
		await expect(file.getByRole('row', { name: /context 70$/ })).toBeVisible();
		await expect(file.getByRole('row', { name: /context 110$/ })).toBeVisible();
		await expect(file.getByRole('row', { name: /context 69$/ })).toHaveCount(0);
		await expect(file.getByRole('row', { name: /context 111$/ })).toHaveCount(0);
		await file.getByRole('button', { name: 'Show all 133 unchanged lines' }).tap();
		await expect(row).toHaveCount(1);
		await expect(file.getByRole('row', { name: /context 111$/ })).toBeVisible();
	} finally {
		await world.close();
	}
});

test('uses visible code ahead of the bottom of the preceding file', async ({ page }) => {
	const world = await makeJourneyWorld();
	try {
		const directory = await world.repository('long-file');
		const repo = GitRepo.open(absolutePath(directory));
		const context = Array.from({ length: 25 }, (_, i) => `context ${String(i + 1)}\n`).join('');
		await repo.write('a.txt', `before A\n${context}`);
		await repo.write('b.txt', `before B\n${context}`);
		await repo.write('c.txt', 'before C\n');
		await repo.commit('Give each file a collapsed context footer');
		await repo.write('a.txt', `after A\n${context}`);
		await repo.write('b.txt', `after B\n${context}`);
		await repo.write('c.txt', context);
		await page.goto((await world.command([], directory)).address);
		const first = page.getByRole('article', { name: 'a.txt' });
		const second = page.getByRole('article', { name: 'b.txt' });
		await expect(
			first.getByRole('button', { name: 'Show all 22 unchanged lines below' })
		).toBeVisible();
		await expect(second.getByRole('row', { name: /after B$/ })).toBeVisible();
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		// Leave a few pixels of the first file's collapsed context footer in view.
		await first.evaluate((element) => {
			window.scrollBy(0, element.getBoundingClientRect().bottom - 8);
		});
		await expect(first).toBeInViewport();
		await expect(first.getByRole('row', { name: /context 3$/ })).not.toBeInViewport();
		await expect(second.getByRole('row', { name: /after B$/ })).toBeInViewport();
		const save = page.getByRole('button', { name: 'Bookmark this spot' });
		await expect(save).toBeInViewport({ ratio: 1 });
		await save.tap();
		await expect(page.getByRole('button', { name: 'Return to bookmark b.txt' })).toBeVisible();
	} finally {
		await world.close();
	}
});

test('explains when the bookmarked section is filtered but another part of the file is visible', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const directory = await world.repository('reading');
		const { address } = await world.command([], directory);
		const report = new URL(address).pathname.split('/').at(-1);
		const file = 'src/pairs.ts';
		await world.agentCall('upsert_sections', {
			report,
			version: 1,
			sections: [{ id: 'prices', title: 'Price updates' }]
		});
		await world.agentCall('assign', {
			report,
			version: 1,
			items: [{ file, hunks: ['h1'], section: 'prices' }]
		});
		await page.goto(address);
		const prices = page
			.getByRole('region', { name: 'Price updates' })
			.getByRole('article', { name: file });
		const row = prices.getByRole('row', { name: /price5 = 55;/ });
		await expect(row).toBeVisible();
		await row.evaluate((element) => {
			element.scrollIntoView({ block: 'start' });
			window.scrollBy(0, 1);
		});
		await page.getByRole('button', { name: 'Bookmark this spot' }).tap();
		await prices.getByRole('checkbox', { name: 'Reviewed: src/pairs.ts' }).check();
		await page.getByRole('button', { name: 'Only what I have not reviewed' }).click();
		await expect(prices).toBeHidden();
		await expect(page.getByRole('article', { name: file })).toBeVisible();
		await page.getByRole('button', { name: 'Return to bookmark src/pairs.ts' }).tap();
		await expect(page.getByRole('group', { name: 'Reading bookmark' })).toContainText(
			'The filters hide the bookmarked line in src/pairs.ts. Show everything to return to it.'
		);
	} finally {
		await world.close();
	}
});
