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
import { startJourney, whatCovers, type Journey } from './journey.ts';
import { makeJourneyWorld } from './journey-world.ts';

const FONTS = join(import.meta.dirname, '..', '..', 'node_modules', '@fontsource');

/** The fonts a planted page may use, served at the app's address like the app's own. */
const FONT_FILES: Readonly<Record<string, string>> = {
	'inter-400.woff2': join(FONTS, 'inter/files/inter-latin-400-normal.woff2'),
	'inter-700.woff2': join(FONTS, 'inter/files/inter-latin-700-normal.woff2')
};

const HELPER = '/__journey-helper';

/**
 * A page that follows the app's rules for fonts, with `body` in its `<main>`,
 * and is ready for input from the start, as the app is once its scripts have run.
 */
function pageWith(body: string, style = ''): string {
	return `<!doctype html>
<html lang="en" data-ready>
<head>
<meta charset="utf-8">
<title>Planted page</title>
<style>
@font-face { font-family: 'Inter'; font-weight: 400; font-style: normal; src: url(${HELPER}/inter-400.woff2) format('woff2'); unicode-range: U+0000-00FF, U+2000-206F; }
@font-face { font-family: 'Inter'; font-weight: 700; font-style: normal; src: url(${HELPER}/inter-700.woff2) format('woff2'); unicode-range: U+0000-00FF, U+2000-206F; }
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
	// The app's API, refusing everything, for the checks on refusals.
	await page.route('**/api/**', async (route) => {
		await route.fulfill({ status: 409, json: { error: { kind: 'Refused', message: 'No.' } } });
	});
	return `${HELPER}/page`;
}

const test = base.extend<{
	planted: (html: string) => Promise<Journey>;
	onTheApp: Journey;
	beforeEntering: Journey;
}>({
	// A daemon of the test's own, whose pages this browser has not been let into yet.
	beforeEntering: async ({ page }, use, testInfo) => {
		const world = await makeJourneyWorld();
		try {
			const running = await startJourney(
				page,
				testInfo,
				world.daemon.origin,
				{ screenshots: 'take' },
				world
			);
			await use(running.journey);
		} finally {
			await world.close();
		}
	},
	planted: async ({ page, baseURL }, use, testInfo) => {
		const running = await startJourney(page, testInfo, baseURL, { screenshots: 'take' });
		await use(async (html) => {
			await running.journey.open(await serve(page, html));
			return running.journey;
		});
	},
	// The app's own start page, served by a daemon of the test's own, as a journey's is.
	onTheApp: async ({ page }, use, testInfo) => {
		const world = await makeJourneyWorld();
		try {
			const running = await startJourney(
				page,
				testInfo,
				world.daemon.origin,
				{ screenshots: 'take' },
				world
			);
			await running.journey.open((await running.journey.command(['serve'])).address);
			await use(running.journey);
		} finally {
			await world.close();
		}
	}
});

const FORM = pageWith(`
<h1>Form</h1>
<label>Name <input name="name"></label>
<label><input type="checkbox" name="agree"> Agree</label>
<button type="button" onclick="this.textContent = 'Pressed'">Press</button>
`);

test.describe('the journey helper acts with the keyboard', () => {
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

	test('lists the whole tab order, even when two controls share a name', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Links</h1>
<a href="#a">Help</a> <a href="#b">Other</a> <a href="#c">Help</a> <a href="#d">Last</a>`)
		);
		expect(await journey.tabOrder()).toEqual([
			'link "Help"',
			'link "Other"',
			'link "Help"',
			'link "Last"'
		]);
		await journey.step('Links');
	});
});

// Lint keeps a journey to the keyboard (scripts/eslint-journey-rules.ts); the
// page is the app's own, and whatever it does to itself passes a step.
test.describe('the journey helper lets the app do what apps do', () => {
	test('passes a field the app filled in, as Svelte does', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Prefilled</h1>
<label>Name <input></label>
<script>document.querySelector('input').value = 'Ada';</script>`)
		);
		await journey.step('Prefilled');
	});

	test('passes a value the app wrote later, with no key pressed', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Later</h1>
<label>Status <input></label><p></p>
<script>setTimeout(() => {
	document.querySelector('input').value = 'Updated';
	document.querySelector('p').textContent = 'Written';
}, 0);</script>`)
		);
		await journey.expectVisible(journey.byText('Written'));
		await journey.step('Written later');
	});

	test('passes a field the app clears after Enter', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Comment</h1>
<label>Comment <input onkeydown="if (event.key === 'Enter') { document.querySelector('p').textContent = this.value; this.value = ''; }"></label><p></p>`)
		);
		await journey.activate(journey.byLabel('Comment'), 'Space');
		await journey.press('Backspace');
		await journey.type('Looks good');
		await journey.press('Enter');
		await journey.expectVisible(journey.byText('Looks good'));
		await journey.step('Cleared');
	});

	test('passes a radio group moved with the arrow keys', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>View</h1>
<fieldset><legend>View</legend>
<label><input type="radio" name="view" value="unified" checked> Unified</label>
<label><input type="radio" name="view" value="split"> Split</label>
</fieldset>`)
		);
		await journey.activate(journey.byLabel('Unified'), 'ArrowDown');
		await journey.step('Split chosen');
	});

	test('passes a select changed with the arrow keys', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Sort</h1>
<label>Sort <select><option>By section</option><option>By file</option></select></label>`)
		);
		await journey.activate(journey.byLabel('Sort'), 'ArrowDown');
		await journey.step('By file');
	});

	test('passes a checkbox toggled with Space', async ({ planted }) => {
		const journey = await planted(FORM);
		await journey.activate(journey.byLabel('Agree'), 'Space');
		await journey.step('Agreed');
	});

	test('passes a styled file picker, a button that opens a hidden file input', async ({
		planted
	}) => {
		const journey = await planted(
			pageWith(`<h1>Open</h1>
<input type="file" hidden onchange="document.querySelector('output').textContent = this.files[0].name">
<button type="button" onclick="document.querySelector('input').click()">Choose a diff</button>
<output></output>`)
		);
		await journey.chooseFiles(journey.byRole('button', { name: 'Choose a diff' }), [
			join(import.meta.dirname, 'journey.spec.ts')
		]);
		await journey.expectVisible(journey.byText('journey.spec.ts'));
		await journey.step('Chosen');
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

	test('comes back to the page, which gets the focus as when the window does', async ({
		planted
	}) => {
		const journey = await planted(
			pageWith(`
<h1>Back</h1>
<output>Away</output>
<script>addEventListener('focus', () => { document.querySelector('output').textContent = 'Back again'; });</script>
`)
		);
		await journey.expectVisible(journey.byText('Away'));
		await journey.returnToPage();
		await journey.expectVisible(journey.byText('Back again'));
		await journey.step('Back');
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

test.describe('the journey helper works in a second tab', () => {
	test('does what a journey does there, and leaves the first tab as it was', async ({
		onTheApp: journey
	}) => {
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		const shop = await journey.repository('shop');
		const run = await journey.command([], shop);
		await journey.inAnotherTab(run.address, async (tab) => {
			await tab.expectVisible(tab.byRole('heading', { level: 1, name: 'Uncommitted changes' }));
			await tab.step('The other tab');
		});
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		expect(await journey.address()).toBe('/');
	});
});

test.describe('the journey helper plays an agent’s link and a window diff delver opens', () => {
	test('the link lets the browser read, and the window diff delver opens lets it comment', async ({
		beforeEntering: journey
	}) => {
		const reading = await journey.repository('reading');
		await expect(journey.openedWindow()).rejects.toThrow('opened no browser window');
		await journey.open(await journey.agentLink(reading));
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Uncommitted changes' })
		);
		const drafts = { name: 'Draft comments', exact: true };
		await journey.expectHidden(journey.byRole('button', drafts));
		await journey.activate(
			journey.byRole('button', { name: 'Turn on comments in this browser', exact: true })
		);
		await journey.expectVisible(journey.byText('A new tab has opened with comments turned on.'));
		const window = await journey.openedWindow();
		// Each window is the journey's to play once.
		await expect(journey.openedWindow()).rejects.toThrow('opened no browser window');
		expect(window).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/diffs\/r_1\?entry=[0-9a-f]{32}$/);
		await journey.inAnotherTab(window, async (tab) => {
			await tab.expectVisible(tab.byRole('button', drafts));
			await tab.step('The window diff delver opened');
		});
		// The first tab is told nothing until the person comes back to it.
		await journey.expectHidden(journey.byRole('button', drafts));
		await journey.returnToPage();
		await journey.expectVisible(journey.byText('Comments are on in this browser now.'));
		await journey.expectFocused(journey.byRole('button', drafts));
		await journey.step('Comments turned on in the first tab');
	});
});

test.describe('the journey helper works in a repository as a person does', () => {
	test('commits everything, so the command finds nothing uncommitted', async ({
		onTheApp: journey
	}) => {
		const shop = await journey.repository('shop');
		expect((await journey.command([], shop)).output).toContain('Uncommitted changes in shop');
		await journey.commitAll(shop, 'Everything');
		expect((await journey.command([], shop)).output).not.toContain('Uncommitted changes');
	});
});

test.describe("the app's own styles", () => {
	test('draw form controls in the page font, not the browser’s', async ({
		page,
		onTheApp: journey
	}) => {
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

test.describe("the journey helper lets through only the API's refusals a step expects", () => {
	const REFUSED = pageWith(`<h1>Refused</h1>
<button type="button" onclick="fetch('/api/diffs/r_1/reviewed').catch(() => undefined)">Tick</button>`);
	const expected = { route: '/api/diffs/[id]/reviewed', status: 409 };

	test('passes a refusal the step declares', async ({ planted }) => {
		const journey = await planted(REFUSED);
		await journey.activate(journey.byRole('button', { name: 'Tick' }));
		await journey.step('Refused as expected', { refusals: [expected] });
	});

	test('fails a refusal the step does not declare, or one of another status', async ({
		planted
	}) => {
		const journey = await planted(REFUSED);
		await journey.activate(journey.byRole('button', { name: 'Tick' }));
		await expect(journey.step('Refused unexpectedly')).rejects.toThrow(
			'refused /api/diffs/r_1/reviewed with 409, which the step did not expect'
		);
		await journey.activate(journey.byRole('button', { name: 'Tick' }));
		await expect(
			journey.step('Refused otherwise', { refusals: [{ ...expected, status: 404 }] })
		).rejects.toThrow('which the step did not expect');
	});

	test('fails a step that expected a refusal that never came', async ({ planted }) => {
		const journey = await planted(REFUSED);
		await expect(journey.step('Not refused', { refusals: [expected] })).rejects.toThrow(
			"expected the app's API to refuse /api/diffs/[id]/reviewed with 409, and it did not"
		);
	});
});

test.describe('the journey helper checks what happens after the last step', () => {
	const LATE = pageWith(`<h1>Late</h1>
<button type="button" onclick="console.error('broke late')">Break</button>
<button type="button" onclick="fetch('https://example.com/x').catch(() => undefined)">Fetch</button>`);

	for (const [button, said] of [
		['Break', 'console error: broke late'],
		['Fetch', 'request to https://example.com/x, outside the app']
	] as const) {
		test(`fails a journey whose page does "${button}" after its last step`, async ({
			page,
			baseURL
		}, testInfo) => {
			const running = await startJourney(page, testInfo, baseURL, { screenshots: 'take' });
			await running.journey.open(await serve(page, LATE));
			await running.journey.step('Before');
			await running.journey.activate(running.journey.byRole('button', { name: button }));
			await expect(running.finish()).rejects.toThrow(said);
		});
	}
});

test('the journey helper checks fonts in the dark colour scheme too', async ({ planted }) => {
	const journey = await planted(
		pageWith(
			'<h1>Dark</h1><p>Text</p>',
			'@media (prefers-color-scheme: dark) { p { font-family: Georgia, serif; } }'
		)
	);
	await expect(journey.step('Dark font')).rejects.toThrow(/\(dark\).*<p> has 4 character/s);
});

test.describe('the journey helper checks that emphasis has a face of its own', () => {
	test('fails on italic text with no bundled italic face', async ({ planted }) => {
		const journey = await planted(pageWith('<h1>Plain</h1><p><em>Slanted</em></p>'));
		await expect(journey.step('Italic')).rejects.toThrow(
			'<em> is set in italic 400 "Inter", but no bundled face of "Inter" is italic 400'
		);
	});

	test('fails on bold text in a weight with no bundled face', async ({ planted }) => {
		const journey = await planted(
			pageWith('<h1>Plain</h1><p><strong>Heavy</strong></p>', 'strong { font-weight: 900; }')
		);
		await expect(journey.step('Heavy')).rejects.toThrow(
			'<strong> is set in 900 "Inter", but no bundled face of "Inter" is 900'
		);
	});

	test("passes the app's emphasis, in its text and its code", async ({
		page,
		onTheApp: journey
	}) => {
		await page.locator('main').evaluate((main) => {
			main.insertAdjacentHTML(
				'beforeend',
				'<p><em>Slanted</em>, <strong>bold</strong>, <strong><em>both</em></strong>, ' +
					'<code>code</code>, <em><code>slanted code</code></em>, ' +
					'<strong><code>bold code</code></strong>, <strong><em><code>both</code></em></strong></p>'
			);
		});
		await journey.step('Emphasis');
	});
});

test.describe('the journey helper has what a journey needs', () => {
	test('says what has focus, and follows it through arrow keys and Shift+Tab', async ({
		planted
	}) => {
		const journey = await planted(
			pageWith(`<h1>Files</h1>
<ul aria-label="Files" onkeydown="const to = event.key === 'ArrowDown' ? event.target.closest('li').nextElementSibling : null; if (to) { event.preventDefault(); to.querySelector('button').focus(); }">
<li><button type="button">One</button></li><li><button type="button" tabindex="-1">Two</button></li>
</ul>
<button type="button">After</button>`)
		);
		expect(await journey.focused()).toBe('');
		const one = journey.byRole('button', { name: 'One' });
		await journey.tabTo(one);
		await journey.expectFocused(one);
		await journey.press('ArrowDown');
		await journey.expectFocused(journey.byRole('button', { name: 'Two' }));
		expect(await journey.focused()).toBe('button "Two"');
		await journey.press('Tab');
		await journey.expectFocused(journey.byRole('button', { name: 'After' }));
		await journey.press('Shift+Tab');
		await journey.expectFocused(one);
		await journey.step('Second file');
	});

	test('finds one of several by its region, or by its place on the page', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Section</h1>
${['a.ts', 'b.ts', 'c.ts']
	.map(
		(file) => `<section aria-label="${file}"><h2>${file}</h2>
<button type="button" onclick="this.closest('section').querySelector('p').textContent = 'Reviewed'">Mark reviewed</button><p></p></section>`
	)
	.join('')}`)
		);
		const fileB = journey.byRole('region', { name: 'b.ts' });
		const markB = journey.within(fileB).byRole('button', { name: 'Mark reviewed' });
		expect(markB.description).toBe('button "Mark reviewed" in region "b.ts"');
		await journey.activate(markB);
		await journey.expectText(fileB, 'Reviewed');
		await journey.expectFocused(
			journey.nth(journey.byRole('button', { name: 'Mark reviewed' }), 2)
		);
		await journey.expectText(journey.within(fileB).byText('Reviewed', { exact: true }), 'Reviewed');
		expect(() => journey.nth(journey.byRole('button'), 0)).toThrow('nth counts from 1');
		await journey.step('One reviewed');
	});

	test('waits for text to change and for something to appear and go', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Sorting</h1>
<p role="status">Sorting the diff</p><p id="busy">Working</p>
<script>setTimeout(() => {
	document.querySelector('[role=status]').textContent = 'Sorted 12 files';
	document.getElementById('busy').remove();
	document.querySelector('main').insertAdjacentHTML('beforeend', '<button type="button">Start reviewing</button>');
}, 300);</script>`)
		);
		await journey.expectText(journey.byRole('status'), /Sorted \d+ files/);
		await journey.expectText(journey.byRole('status'), 'Sorted 12');
		await journey.expectHidden(journey.byText('Working'));
		await journey.expectVisible(journey.byRole('button', { name: 'Start reviewing' }));
		await journey.step('Sorted');
	});

	test('presses keyboard shortcuts with modifiers', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Comment</h1>
<label>Comment <textarea onkeydown="if (event.ctrlKey && event.key === 'Enter') document.querySelector('output').textContent = 'Sent: ' + this.value"></textarea></label>
<output></output>`)
		);
		await journey.tabTo(journey.byLabel('Comment'));
		await journey.type('Fine');
		await journey.press('Control+Enter');
		await journey.expectText(journey.byRole('status'), 'Sent: Fine');
		await journey.step('Sent');
	});

	test('scrolls a long page with the keyboard and takes another step', async ({ planted }) => {
		const lines = Array.from({ length: 200 }, (_, i) => `<p>Line ${String(i + 1)}</p>`);
		const journey = await planted(pageWith(`<h1>Long</h1>${lines.join('')}`));
		await journey.step('Top');
		await journey.press('End');
		await journey.expectInView(journey.byText('Line 200', { exact: true }));
		await journey.step('Bottom');
	});

	test('tells a heading under a bar that stays at the top from one below it', async ({
		planted,
		page
	}) => {
		const lines = Array.from({ length: 100 }, (_, i) => `<p>Line ${String(i + 1)}</p>`);
		const journey = await planted(
			pageWith(`<h1>Bar</h1>
<div role="search" aria-label="Find" style="position: sticky; top: 0; height: 80px; background: white">Find</div>
${lines.join('')}<h2 id="under" tabindex="-1">Under</h2><h2 id="below" tabindex="-1">Below</h2>${lines.join('')}
<button type="button" onclick="document.getElementById('under').scrollIntoView({ block: 'start' })">To under</button>
<button type="button" onclick="document.getElementById('below').scrollIntoView({ block: 'center' })">To below</button>`)
		);
		await journey.activate(journey.byRole('button', { name: 'To under' }));
		await journey.expectInView(journey.byRole('heading', { name: 'Under' }));
		expect(await whatCovers(page.getByRole('heading', { name: 'Under' }))).toBe(
			'under <div> "Find"'
		);
		await journey.activate(journey.byRole('button', { name: 'To below' }));
		await journey.expectUncovered(journey.byRole('heading', { name: 'Below' }));
		await journey.step('Below the bar');
	});

	test('reads where a link goes and where the browser is', async ({ planted }) => {
		const journey = await planted(
			pageWith(`<h1>Links</h1>
<a href="#second">Second section</a> <a href="https://example.com/x">Elsewhere</a>
<p>Not a link</p><h2 id="second">Second</h2>`)
		);
		const second = journey.byRole('link', { name: 'Second section' });
		expect(await journey.address()).toBe('/__journey-helper/page');
		expect(await journey.destinationOf(second)).toBe('/__journey-helper/page#second');
		expect(await journey.destinationOf(journey.byRole('link', { name: 'Elsewhere' }))).toBe(
			'https://example.com/x'
		);
		await expect(journey.destinationOf(journey.byText('Not a link'))).rejects.toThrow(
			'is not a link'
		);
		await journey.activate(second);
		expect(await journey.address()).toBe('/__journey-helper/page#second');
		await journey.step('Followed');
	});

	test("checks a control's state: checked, pressed, expanded, selected, disabled", async ({
		planted
	}) => {
		const journey = await planted(
			pageWith(`<h1>State</h1>
<label><input type="checkbox"> Hide whitespace</label>
<label><input type="checkbox" id="some"> Some reviewed</label>
<script>document.getElementById('some').indeterminate = true;</script>
<button type="button" aria-pressed="false" onclick="this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'))">Split view</button>
<button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'true')">Agent notes</button>
<div role="tablist" aria-label="View"><button type="button" role="tab" aria-selected="true">By section</button><button type="button" role="tab" tabindex="-1">By file</button></div>
<button type="button" disabled>Finish review</button>`)
		);
		const hide = journey.byLabel('Hide whitespace');
		const split = journey.byRole('button', { name: 'Split view' });
		const notes = journey.byRole('button', { name: 'Agent notes' });
		await journey.expectState(hide, { checked: false });
		await journey.activate(hide, 'Space');
		await journey.expectState(hide, { checked: true });
		await journey.expectState(journey.byLabel('Some reviewed'), { checked: 'mixed' });
		await journey.expectState(split, { pressed: false });
		await journey.activate(split);
		await journey.expectState(split, { pressed: true, disabled: false });
		await journey.expectState(notes, { expanded: false });
		await journey.activate(notes);
		await journey.expectState(notes, { expanded: true });
		await journey.expectState(journey.byRole('tab', { name: 'By section' }), { selected: true });
		await journey.expectState(journey.byRole('tab', { name: 'By file' }), { selected: false });
		await journey.expectState(journey.byRole('button', { name: 'Finish review' }), {
			disabled: true
		});
		await journey.step('States');
	});
});

/**
 * Makes the page slow to start, as on a busy machine: the CPU four times slower
 * and the page's own scripts late by `delay` milliseconds, so it is drawn and
 * can be read well before it can act on a key.
 */
async function slowDown(page: Page, delay: number): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
	await page.route('**/_app/immutable/nodes/**', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, delay));
		await route.continue();
	});
}

test.describe('no key is lost on a page that is slow to start', () => {
	test('the helper waits until the page can act before it presses a key', async ({
		page
	}, testInfo) => {
		const world = await makeJourneyWorld();
		try {
			await slowDown(page, 1_000);
			const running = await startJourney(
				page,
				testInfo,
				world.daemon.origin,
				{ screenshots: 'take' },
				world
			);
			const { journey } = running;
			const run = await journey.command([], await journey.repository('shop'));
			await journey.open(run.address);
			await journey.press('n');
			await journey.expectFocused(journey.byRole('button', { name: 'src/cart.ts', exact: true }));
			await journey.press('r');
			await journey.expectState(journey.byRole('checkbox', { name: 'Reviewed: src/cart.ts' }), {
				checked: true
			});
			await journey.step('Ticked on a slow page');
			await running.finish();
		} finally {
			await world.close();
		}
	});

	test('the app acts on keys pressed before its scripts have run', async ({ page }) => {
		const world = await makeJourneyWorld();
		try {
			await slowDown(page, 1_500);
			const run = await world.command([], await world.repository('shop'));
			// Not the helper: keys straight after the page is drawn, before it says it is ready.
			await page.goto(run.address);
			await expect(page.getByRole('button', { name: /^Start reviewing/ })).toBeVisible();
			expect(await page.locator('html[data-ready]').count()).toBe(0);
			await page.keyboard.press('n');
			await page.keyboard.press('r');
			await expect(page.getByRole('checkbox', { name: 'Reviewed: src/cart.ts' })).toBeChecked();
			// Enter on a button that had focus before then does what the button does.
			await page.goto(page.url());
			expect(await page.locator('html[data-ready]').count()).toBe(0);
			await page.getByRole('button', { name: /^Next unread/ }).focus();
			await page.keyboard.press('Enter');
			await expect(page.locator('#part-1-toggle')).toBeFocused();
		} finally {
			await world.close();
		}
	});

	test('keys the page does not act on are left to the browser, and Enter does not tick', async ({
		page
	}) => {
		const world = await makeJourneyWorld();
		try {
			await slowDown(page, 1_500);
			const run = await world.command([], await world.repository('shop'));
			await page.goto(run.address);
			await expect(page.getByRole('button', { name: /^Start reviewing/ })).toBeVisible();
			// A scrolling key scrolls at once, as the browser would, though the page is not ready.
			await page.keyboard.press('PageDown');
			await expect
				.poll(() =>
					page.evaluate(() => ({
						scrolled: scrollY > 0,
						ready: document.documentElement.hasAttribute('data-ready')
					}))
				)
				.toEqual({ scrolled: true, ready: false });

			// Enter on a tick box does not tick it; Space does, once.
			await page.goto(page.url());
			const tick = page.getByRole('checkbox', { name: 'Reviewed: src/cart.ts' });
			expect(await page.locator('html[data-ready]').count()).toBe(0);
			await tick.focus();
			await page.keyboard.press('Enter');
			await page.locator('html[data-ready]').waitFor({ state: 'attached' });
			await expect(tick).not.toBeChecked();
			await page.goto(page.url());
			expect(await page.locator('html[data-ready]').count()).toBe(0);
			await tick.focus();
			await page.keyboard.press(' ');
			await page.locator('html[data-ready]').waitFor({ state: 'attached' });
			await expect(tick).toBeChecked();
		} finally {
			await world.close();
		}
	});

	test('when the page’s scripts fail to start, the keyboard is the browser’s again', async ({
		page
	}) => {
		const world = await makeJourneyWorld();
		try {
			await page.route('**/_app/immutable/entry/start.*', (route) => route.abort());
			const run = await world.command([], await world.repository('shop'));
			const failed = page.waitForEvent('pageerror');
			await page.goto(run.address);
			await failed;
			// The link to all diffs works without scripts, as a link does.
			await page.getByRole('link', { name: 'See all your Delves' }).focus();
			await page.keyboard.press('Enter');
			await expect(page).toHaveURL(new URL('/', run.address).href);
		} finally {
			await world.close();
		}
	});
});
