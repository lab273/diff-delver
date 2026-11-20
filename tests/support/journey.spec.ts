/**
 * The journey helper's own tests (tests/support/journey.ts), in the journey
 * browser, on small pages they serve themselves at the app's address. Each
 * plants what a journey must never get away with and checks that the next step
 * fails, saying why; and checks that what a journey may do passes.
 *
 * Their steps take screenshots as a journey's do but keep none, so these tests
 * have no committed images.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { startJourney, type Journey } from './journey.ts';

const FONTS = join(import.meta.dirname, '..', '..', 'node_modules', '@fontsource');

/** The fonts a planted page may use, served at the app's address like the app's own. */
const FONT_FILES: Readonly<Record<string, string>> = {
	'inter-400.woff2': join(FONTS, 'inter/files/inter-latin-400-normal.woff2')
};

const HELPER = '/__journey-helper';

/** A page that follows the app's rules for fonts, with `body` in its `<main>`. */
function pageWith(body: string, style = ''): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Planted page</title>
<style>
@font-face { font-family: 'Inter'; font-weight: 400; font-style: normal; src: url(${HELPER}/inter-400.woff2) format('woff2'); }
html { font-family: 'Inter'; font-synthesis: none; }
button, input, select, textarea { font: inherit; }
${style}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** Serves `html` at a page of the app's address, and the fonts beside it. */
async function serve(page: Page, html: string): Promise<string> {
	await page.route(`**${HELPER}/**`, async (route) => {
		const name = new URL(route.request().url()).pathname.slice(HELPER.length + 1);
		const font = FONT_FILES[name];
		if (font !== undefined) {
			await route.fulfill({ body: await readFile(font), contentType: 'font/woff2' });
		} else {
			await route.fulfill({ body: html, contentType: 'text/html' });
		}
	});
	return `${HELPER}/page`;
}

const test = base.extend<{ planted: (html: string) => Promise<Journey> }>({
	planted: async ({ page, baseURL }, use, testInfo) => {
		const running = await startJourney(page, testInfo, baseURL, { screenshots: 'take' });
		await use(async (html) => {
			await running.journey.open(await serve(page, html));
			return running.journey;
		});
	}
});

const FORM = pageWith(`
<h1>Form</h1>
<label>Name <input name="name"></label>
<label><input type="checkbox" name="agree"> Agree</label>
<button type="button" onclick="this.textContent = 'Pressed'">Press</button>
`);

test.describe('the journey helper keeps journeys to the keyboard', () => {
	test('lets typing, Space on a checkbox and Enter on a button through', async ({ planted }) => {
		const journey = await planted(FORM);
		await journey.activate(journey.byLabel('Name'), 'Space');
		await journey.press('Backspace');
		await journey.type('Ada');
		await journey.activate(journey.byLabel('Agree'), 'Space');
		await journey.activate(journey.byRole('button', { name: 'Press' }));
		await journey.expectVisible(journey.byRole('button', { name: 'Pressed' }));
		await journey.step('Filled in');
	});

	test('fails on a click made by a script', async ({ planted, page }) => {
		const journey = await planted(FORM);
		await page.getByRole('button').evaluate((element) => {
			HTMLElement.prototype.click.call(element);
		});
		await expect(journey.step('After')).rejects.toThrow('a "click" event made by a script');
	});

	test('fails on a value set by a script with an input event', async ({ planted, page }) => {
		const journey = await planted(FORM);
		await page.getByLabel('Name').evaluate((element) => {
			if (element instanceof HTMLInputElement) element.value = 'Ada';
			element.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await expect(journey.step('After')).rejects.toThrow('a "input" event made by a script');
	});

	test('fails on a value set by a script with no event at all', async ({ planted, page }) => {
		const journey = await planted(FORM);
		await page.getByLabel('Name').evaluate((element) => {
			if (element instanceof HTMLInputElement) element.value = 'Ada';
		});
		await expect(journey.step('After')).rejects.toThrow(
			'a <input> whose value changed without typing'
		);
	});

	test('fails on a field filled in without typing', async ({ planted, page }) => {
		const journey = await planted(FORM);
		await page.getByLabel('Name').fill('Ada');
		await expect(journey.step('After')).rejects.toThrow('text entered without typing it');
	});

	test('fails on a click with the mouse', async ({ planted, page }) => {
		const journey = await planted(FORM);
		await page.getByRole('button').click();
		await expect(journey.step('After')).rejects.toThrow('a pointerdown event');
	});
});

test.describe('the journey helper does what a person does outside the page', () => {
	test('reads what the app copied to the clipboard', async ({ planted }) => {
		const journey = await planted(
			pageWith(`
<h1>Copy</h1>
<button type="button" onclick="navigator.clipboard.writeText('the review')">Copy the review</button>
`)
		);
		await journey.activate(journey.byRole('button', { name: 'Copy the review' }));
		await expect.poll(() => journey.readClipboard()).toBe('the review');
		await journey.step('Copied');
	});

	test('chooses a file in the file chooser, opened with the keyboard', async ({ planted }) => {
		const journey = await planted(
			pageWith(`
<h1>Open</h1>
<label>Diff file <input type="file" onchange="document.querySelector('output').textContent = this.files[0].name"></label>
<output></output>
`)
		);
		await journey.chooseFiles(journey.byLabel('Diff file'), [
			join(import.meta.dirname, 'journey.spec.ts')
		]);
		await journey.expectVisible(journey.byText('journey.spec.ts'));
		await journey.step('Chosen');
	});
});
