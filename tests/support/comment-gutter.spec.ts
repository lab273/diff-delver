import { expect, test } from '@playwright/test';
import { makeJourneyWorld } from './journey-world.ts';

// Journeys drive the keyboard. Exercise the browser's pointer capture here.
test('dragging line numbers selects a range on the starting side', async ({ page }) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		await page.goto((await world.command([], repo)).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const file = page.getByRole('article', { name: 'src/lexer.ts' });
		await file.getByRole('button', { name: 'Show all 8 unchanged lines above' }).click();
		await file.getByRole('button', { name: 'Comment on lines' }).click();
		const first = file.getByRole('button', { name: 'Before, line 1', exact: true });
		const last = file.getByRole('button', { name: 'Before, line 3', exact: true });
		await last.scrollIntoViewIfNeeded();
		const from = await first.boundingBox();
		const to = await last.boundingBox();
		if (from === null || to === null) throw new Error('The gutter must be drawn before dragging');
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
		await page.mouse.up();
		await expect(last).toBeFocused();
		await expect(file.locator('button.pick-line[tabindex="0"]')).toHaveCount(1);
		await expect(first).toHaveAttribute('aria-pressed', 'true');
		await expect(file.getByRole('button', { name: 'Before, line 2', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(last).toHaveAttribute('aria-pressed', 'true');
		await expect(file.getByRole('button', { name: 'After, line 2', exact: true })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
		await file.getByRole('button', { name: 'Write comment', exact: true }).click();
		await expect(page.getByRole('form', { name: 'Unsaved comment' })).toContainText(
			'Before, lines 1–3'
		);
	} finally {
		await world.close();
	}
});
