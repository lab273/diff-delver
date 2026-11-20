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
@font-face { font-family: 'Inter'; font-weight: 400; font-style: normal; src: url(${HELPER}/inter-400.woff2) format('woff2'); unicode-range: U+0000-00FF, U+2000-206F; }
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

test.describe('the journey helper finds text drawn in a font that is not bundled', () => {
	const georgia = (body: string): string =>
		pageWith(`<h1>Fonts</h1>${body}`, '.odd { font-family: Georgia, serif; }');

	test('passes a page drawn only in the bundled font', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Fonts</h1>
<label>Name <input value="Ada" placeholder="Your name"></label>
<label>Notes <textarea placeholder="Notes">Some</textarea></label>
<label>Pick <select><option>One</option></select></label>
<button type="button">Go</button>
<svg width="80" height="20" role="img" aria-label="Label"><text x="0" y="15">Label</text></svg>`)
		);
		await journey.step('Bundled only');
	});

	const odd: readonly (readonly [string, string, string])[] = [
		['the value of a field', '<label>Name <input class="odd" value="Ada"></label>', '<input>'],
		[
			'the placeholder of a field',
			'<label>Name <input class="odd" placeholder="Your name"></label>',
			'<input>'
		],
		[
			'the text of a text area',
			'<label>Notes <textarea class="odd">Some</textarea></label>',
			'<textarea>'
		],
		[
			'the choice in a select',
			'<label>Pick <select class="odd"><option>One</option></select></label>',
			'<select>'
		],
		['a button', '<button type="button" class="odd">Go</button>', '<button>'],
		[
			'SVG text',
			'<svg width="80" height="20" role="img" aria-label="Label"><text class="odd" x="0" y="15">Label</text></svg>',
			'<text>'
		],
		[
			'text in a shadow root',
			'<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = \'<p class="odd" style="font-family: Georgia">Shadow</p>\';</script>',
			'<p>'
		]
	];
	for (const [name, body, element] of odd) {
		test(`fails on ${name}`, async ({ planted }) => {
			const journey = await planted(georgia(body));
			await expect(journey.step('Odd font')).rejects.toThrow(
				new RegExp(`${element.replace(/[<>]/g, '\\$&')}.*drawn in an installed font`)
			);
		});
	}

	test('fails on a button that does not inherit the page font', async ({ planted }) => {
		const journey = await planted(
			pageWith('<h1>Fonts</h1><button type="button">Go</button>', 'button { font: revert; }')
		);
		await expect(journey.step('Default button')).rejects.toThrow(/<button>/);
	});

	test('fails on a character no bundled face covers, in a field', async ({ planted }) => {
		const journey = await planted(
			pageWith('<h1>Fonts</h1><label>Name <input value="Ada ☃"></label>')
		);
		await expect(journey.step('Snowman')).rejects.toThrow('<input> shows "☃"');
	});
});

test.describe("the app's own styles", () => {
	test('draw form controls in the page font, not the browser’s', async ({
		page,
		baseURL
	}, testInfo) => {
		const { journey } = await startJourney(page, testInfo, baseURL, { screenshots: 'take' });
		await journey.open('/');
		// The app has no form yet; these stand in for the first one.
		await page.locator('main').evaluate((main) => {
			main.insertAdjacentHTML(
				'beforeend',
				'<label>Name <input value="Ada" placeholder="Your name"></label>' +
					'<label>Notes <textarea>Some</textarea></label>' +
					'<label>Pick <select><option>One</option></select></label>' +
					'<button type="button">Go</button>'
			);
		});
		await journey.step('Form controls');
	});
});

// A step once took over 30 seconds on this page, against about one on the start
// page: it took full-page screenshots and asked about every element's font one
// at a time. Its time is held to the journey guidance by pnpm verify.
test.describe('a step on a long page', () => {
	test('takes about what a step on a short page does', async ({ planted }) => {
		const lines = Array.from(
			{ length: 3_000 },
			(_, i) => `<p>Line ${String(i + 1)} of the diff</p>`
		);
		const journey = await planted(pageWith(`<h1>Long</h1>${lines.join('')}`));
		await journey.step('Long page');
	});
});
