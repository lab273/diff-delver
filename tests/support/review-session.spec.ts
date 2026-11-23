import { expect, test, type Page } from '@playwright/test';
import { makeJourneyWorld } from './journey-world.ts';
import { mcpOverHttp } from './mcp-client.ts';

const LINK_SITE = 'http://links.test/';

async function followFromAnotherSite(page: Page, address: string): Promise<void> {
	await page.route(
		LINK_SITE,
		(route) =>
			route.fulfill({
				contentType: 'text/html',
				body: `<!doctype html><a href="${address}">Open the Delve</a>`
			}),
		{ times: 1 }
	);
	await page.goto(LINK_SITE);
	const request = page.waitForRequest(address);
	await page.getByRole('link', { name: 'Open the Delve' }).click();
	const first = await request;
	expect(await first.headerValue('sec-fetch-site')).toBe('cross-site');
	expect(await first.headerValue('cookie')).toBeNull();

	const clean = new URL(address);
	clean.searchParams.delete('entry');
	await expect(page).toHaveURL(clean.href);
	await expect(page.getByRole('heading', { name: 'Uncommitted changes' })).toBeVisible();
}

test('a cross-site MCP link opens the Delve with or without review access in the browser', async ({
	page
}) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('reading');
		const { daemon } = world;
		const mcp = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: repo
		});
		try {
			async function link(): Promise<string> {
				const answer = await mcp.call('create_report', { source: 'working-tree' });
				const address = /Give the person this address to open it in their browser: (http:\S+)/.exec(
					answer.text
				)?.[1];
				if (address === undefined) throw new Error('MCP gave no entry link');
				return address;
			}

			await followFromAnotherSite(page, await link());
			const notice = page.getByRole('region', { name: 'Comments are off in this browser' });
			await expect(notice).toBeVisible();
			await expect(
				notice.getByRole('button', { name: 'Turn on comments in this browser' })
			).toBeVisible();
			await expect(page.getByRole('button', { name: 'Comment on lines' })).toHaveCount(0);
			const delve = page.url();

			// The command's link, opened in another tab of this browser, turns comments
			// on here as well, once the person comes back to this tab: no reload.
			const cliTab = await page.context().newPage();
			try {
				await cliTab.goto((await world.command(['choose'], repo)).address);
				await expect(cliTab).toHaveURL(/\/choose\?/);
				await expect(cliTab.getByRole('heading', { level: 1 })).toBeVisible();
			} finally {
				await cliTab.close();
			}
			await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
			await expect(notice).toHaveCount(0);
			await expect(page).toHaveURL(delve);
			const drafts = page.getByRole('button', { name: 'Draft comments', exact: true });
			await expect(drafts).toBeVisible();
			await drafts.click();
			await expect(page.getByText('To write a draft comment, open a file')).toBeVisible();

			await followFromAnotherSite(page, await link());
			await expect(page).toHaveURL(delve);
			await expect(drafts).toBeVisible();
			await drafts.click();
			await expect(page.getByText('To write a draft comment, open a file')).toBeVisible();
		} finally {
			await mcp.close();
		}
	} finally {
		await world.close();
	}
});
