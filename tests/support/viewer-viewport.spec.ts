import { expect, test } from '@playwright/test';
import { absolutePath, GitRepo } from './git-repo.ts';
import { makeJourneyWorld } from './journey-world.ts';

for (const finishReview of [false, true]) {
	test(`scrolling during a filtered ${finishReview ? 'section' : 'file'} tick keeps the new reading place`, async ({
		page
	}) => {
		await page.setViewportSize({ width: 880, height: 500 });
		const world = await makeJourneyWorld();
		const release = Promise.withResolvers<undefined>();
		try {
			const directory = await world.repository('reading');
			const repo = GitRepo.open(absolutePath(directory));
			await repo.commit('Base for the viewport check');
			const names = ['first.txt', 'intermediate.txt', 'last.txt'];
			for (const name of names) {
				await repo.write(
					name,
					Array.from({ length: 130 }, (_, i) => `${name} line ${i + 1}\n`).join('')
				);
			}
			await page.goto((await world.command([], directory)).address);
			await expect(page.locator('html[data-ready]')).toHaveCount(1);
			await page.getByRole('button', { name: 'Only what I have not reviewed' }).click();
			const first = page.getByRole('article', { name: 'first.txt', exact: true });
			const last = page.getByRole('article', { name: 'last.txt', exact: true });
			const tick = page.getByRole('checkbox', {
				name: finishReview ? 'All reviewed: Not sorted yet' : 'Reviewed: first.txt'
			});
			const lastLine = last.getByRole('row', { name: /last\.txt line 130$/ });
			// Let the last file load before End so a late layout cannot move the end.
			await last.scrollIntoViewIfNeeded();
			await expect(lastLine).toBeVisible();
			const requested = Promise.withResolvers<undefined>();
			await page.route('**/reviewed', async (route) => {
				requested.resolve(undefined);
				await release.promise;
				await route.continue();
			});
			await tick.focus();
			await page.keyboard.press('Space');
			await requested.promise;
			await page.keyboard.press('End');

			const distanceFromEnd = (): Promise<number> =>
				page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY);
			await expect.poll(distanceFromEnd).toBeLessThan(2);
			await expect(lastLine).toBeInViewport();
			const lastTop = (await last.boundingBox())?.y ?? 0;
			release.resolve(undefined);
			await expect(first).toHaveCount(0);

			if (finishReview) {
				await expect(page.getByRole('heading', { name: 'Everything is reviewed' })).toBeFocused();
			} else {
				await expect(last.getByRole('button', { name: 'last.txt' })).toBeFocused();
				expect((await last.boundingBox())?.y).toBeCloseTo(lastTop, 0);
			}
			await expect.poll(distanceFromEnd).toBeLessThan(2);
		} finally {
			release.resolve(undefined);
			await world.close();
		}
	});
}

test('search shows a match between wrapped sticky controls and the bookmark toolbar', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 460 });
	const world = await makeJourneyWorld();
	try {
		const directory = await world.repository('reading');
		const repo = GitRepo.open(absolutePath(directory));
		await repo.commit('Base for the search check');
		const name = 'a-long-file-name-for-a-review-header-that-wraps-to-more-than-one-line.txt';
		await repo.write(
			name,
			Array.from({ length: 150 }, (_, i) =>
				i === 75 ? 'unique needle\n' : `a nearby line ${i + 1}\n`
			).join('')
		);
		await page.goto((await world.command([], directory)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const part = page.getByRole('article', { name });
		const line = part.getByRole('row', { name: /a nearby line 40$/ });
		await line.scrollIntoViewIfNeeded();
		await expect(line).toBeInViewport();
		await page.keyboard.press('b');
		const toolbar = page.getByRole('group', { name: 'Reading bookmark' });
		await expect(toolbar.getByRole('button', { name: /^Return to bookmark/ })).toBeVisible();

		await page.keyboard.press('/');
		const input = page.getByRole('searchbox', { name: 'Search the diff' });
		await expect(input).toBeFocused();
		await input.fill('unique needle');
		await input.press('Enter');
		const match = part.locator('[data-current-match]');
		await expect(match).toContainText('unique needle');

		// Keep this viewport short enough that centring against the window
		// would put the match under the wrapped search and file header.
		await expect
			.poll(() =>
				match.evaluate((element) => {
					const search = document.querySelector('[role="search"]')?.getBoundingClientRect();
					const header = element
						.closest('article')
						?.querySelector('header')
						?.getBoundingClientRect();
					const bookmarks = document.querySelector('.narrow-bookmarks')?.getBoundingClientRect();
					const match = element.getBoundingClientRect();
					const above = Math.max(search?.bottom ?? 0, header?.bottom ?? 0);
					return {
						windowCentreIsCovered: above > innerHeight / 2,
						matchClearsHeader: match.top >= above - 1,
						matchClearsBookmarks: match.bottom <= (bookmarks?.top ?? 0) + 1
					};
				})
			)
			.toEqual({
				windowCentreIsCovered: true,
				matchClearsHeader: true,
				matchClearsBookmarks: true
			});
	} finally {
		await world.close();
	}
});
