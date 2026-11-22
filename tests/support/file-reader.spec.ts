import { expect, test, type Page } from '@playwright/test';
import { absolutePath, GitRepo } from './git-repo.ts';
import { makeJourneyWorld } from './journey-world.ts';

async function openFile(page: Page, path: string, query: string): Promise<void> {
	await page.keyboard.press('t');
	const input = page.getByRole('combobox', { name: 'File name or path' });
	await expect(input).toBeFocused();
	await input.fill(query);
	await expect(page.getByRole('option', { name: path + ' Changed', exact: true })).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: path })).toBeVisible();
}

for (const reload of [false, true]) {
	test(`Forward opens the reader’s own version after an update${reload ? ' and reload' : ''}`, async ({
		page
	}) => {
		const world = await makeJourneyWorld();
		try {
			const directory = await world.repository('reading');
			const repo = GitRepo.open(absolutePath(directory));
			const path = 'src/price.ts';
			await repo.write(path, 'export const original = 0;\n');
			await repo.commit('Start price file');
			await repo.write(path, 'export const first = "one";\n');
			await page.goto((await world.command([], directory)).address);
			await expect(page.locator('html[data-ready]')).toHaveCount(1);
			const part = page.getByRole('article', { name: path });
			const first = part.getByRole('row', { name: /export const first/ });
			await first.scrollIntoViewIfNeeded();
			await page.keyboard.press('b');
			const bookmark = page.getByRole('button', { name: `Return to bookmark ${path}` });
			await expect(bookmark).toBeVisible();
			const draft = page
				.getByRole('form', { name: 'Unsaved comment' })
				.getByRole('textbox', { name: 'Comment', exact: true });
			if (!reload) {
				await part.getByRole('button', { name: 'Comment on lines' }).click();
				await page.keyboard.press('Enter');
				await draft.fill('Keep this draft through history.');
				await page.getByRole('button', { name: 'Open file', exact: true }).focus();
			}

			await openFile(page, path, 'price.ts');
			const reader = page.getByRole('dialog', { name: path });
			await expect(reader.locator('.code-string')).toHaveText('"one"');
			const originalAddress = page.url();
			expect(new URL(originalAddress).searchParams.get('version')).toBe('1');
			await page.goBack();
			await expect(reader).toBeHidden();

			await repo.write(path, 'export const second = "two";\n');
			await page.evaluate(() => window.dispatchEvent(new Event('focus')));
			const changed = page.getByRole('region', { name: 'Your files have changed' });
			await changed.getByRole('button', { name: 'Update' }).click();
			await expect(page.getByRole('heading', { name: /Updated to version 2/ })).toBeVisible();
			if (reload) await page.reload();
			await expect(part.getByRole('row', { name: /export const second/ })).toBeVisible();

			await page.goForward();
			await expect(page).toHaveURL(originalAddress);
			await expect(reader.locator('code')).toHaveText('export const first = "one";');
			await expect(reader.locator('.code-string')).toHaveText('"one"');
			await reader.getByRole('button', { name: 'Show base' }).click();
			await expect(reader.locator('code')).toHaveText('export const original = 0;');
			expect(new URL(page.url()).searchParams.get('version')).toBe('1');
			await reader.getByRole('button', { name: 'Show head' }).click();
			await expect(page).toHaveURL(originalAddress);
			await reader.getByRole('button', { name: 'Show change at line 1 in the diff' }).click();
			await expect(reader).toBeHidden();
			expect(new URL(page.url()).searchParams.get('version')).toBe('1');
			await expect(first).toBeFocused();
			await expect(bookmark).toBeVisible();
			if (!reload) await expect(draft).toHaveValue('Keep this draft through history.');
			await page.goBack();
			await expect(page).toHaveURL(originalAddress);
			await expect(reader.locator('.code-string')).toHaveText('"one"');
			await page.goBack();
			await expect(reader).toBeHidden();
			await expect(part.getByRole('row', { name: /export const second/ })).toBeVisible();
		} finally {
			await world.close();
		}
	});
}

test('reopening the reader cancels a gutter jump waiting for its part', async ({ page }) => {
	const world = await makeJourneyWorld();
	const release = Promise.withResolvers<undefined>();
	try {
		const path = 'data/rows.txt';
		await page.goto((await world.command([], await world.repository('long-file'))).address);
		await expect(page.locator('html[data-ready]')).toHaveCount(1);
		const large = page.getByRole('button', { name: 'Show this large change' });
		await expect(large).toBeVisible();
		await openFile(page, path, 'rows');
		const reader = page.getByRole('dialog', { name: path });
		const gutter = reader.getByRole('button', { name: 'Show change at line 1 in the diff' });
		const requested = Promise.withResolvers<undefined>();
		await page.route(
			'**/part?*',
			async (route) => {
				requested.resolve(undefined);
				await release.promise;
				await route.continue();
			},
			{ times: 1 }
		);
		await gutter.click();
		await requested.promise;
		await expect(reader).toBeHidden();
		await page.goForward();
		await expect(gutter).toBeVisible();
		const answered = page.waitForResponse((response) =>
			new URL(response.url()).pathname.endsWith('/part')
		);
		release.resolve(undefined);
		await (await answered).finished();
		await page.goBack();
		await expect(reader).toBeHidden();
		await expect(large).toBeVisible();
	} finally {
		release.resolve(undefined);
		await world.close();
	}
});
