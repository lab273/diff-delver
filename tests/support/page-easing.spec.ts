import { expect, test, type Page } from '@playwright/test';
import { absolutePath, GitRepo } from './git-repo.ts';
import { makeJourneyWorld } from './journey-world.ts';

// Journeys run with reduced motion, so a move jumps there. Without it, a move
// the page makes eases into place over a few frames (`page-mover.ts`).
test.use({ reducedMotion: 'no-preference', viewport: { width: 880, height: 500 } });

/** The window's scroll on every frame while `act` runs and for a while after. */
async function scrollsDuring(page: Page, act: () => Promise<void>): Promise<number[]> {
	const recording = page.evaluate(
		() =>
			new Promise<number[]>((resolve) => {
				const seen: number[] = [];
				const start = performance.now();
				const record = (): void => {
					seen.push(window.scrollY);
					if (performance.now() - start < 800) requestAnimationFrame(record);
					else resolve(seen);
				};
				requestAnimationFrame(record);
			})
	);
	await act();
	return recording;
}

test('a move to the next file eases into place, and jumps with reduced motion', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const directory = await world.repository('reading');
		const repo = GitRepo.open(absolutePath(directory));
		await repo.commit('Base for the easing check');
		for (const name of ['first.txt', 'second.txt', 'third.txt']) {
			await repo.write(name, Array.from({ length: 130 }, (_, i) => `${name} ${i + 1}\n`).join(''));
		}
		await page.goto((await world.command([], directory)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const toggle = (name: string) => page.getByRole('button', { name, exact: true });
		await page.keyboard.press('j');
		await expect(toggle('first.txt')).toBeFocused();

		const scrolled = (): Promise<number> => page.evaluate(() => window.scrollY);
		const start = await scrolled();
		const eased = await scrollsDuring(page, () => page.keyboard.press('j'));
		await expect(toggle('second.txt')).toBeFocused();
		const end = eased.at(-1) ?? 0;
		expect(end - start).toBeGreaterThan(1000);
		// Several frames on the way, each further along, none past where it stops.
		const between = eased.filter((y) => y > start + 1 && y < end - 1);
		expect(between.length).toBeGreaterThanOrEqual(3);
		expect(eased).toEqual([...eased].sort((a, b) => a - b));

		await page.emulateMedia({ reducedMotion: 'reduce' });
		const from = await scrolled();
		const jumped = await scrollsDuring(page, () => page.keyboard.press('j'));
		await expect(toggle('third.txt')).toBeFocused();
		const to = jumped.at(-1) ?? 0;
		expect(to - from).toBeGreaterThan(1000);
		// There at once: from the first frame that moved, every one is where it stops.
		const moved = jumped.slice(jumped.findIndex((y) => y !== from));
		expect(moved.filter((y) => y !== to)).toEqual([]);
	} finally {
		await world.close();
	}
});
