/**
 * The journey helper. Every journey is written with it (lint allows no other
 * `test` in tests/journeys), as named steps:
 *
 *     test('J1 Something', async ({ journey }) => {
 *         await journey.open('/');
 *         await journey.step('Start page');
 *         await journey.activate(journey.page.getByRole('button', { name: 'Start reviewing' }));
 *         await journey.step('First section');
 *     });
 *
 * One `step` call does everything that must hold on every screen, so a journey
 * cannot leave part of it out (README, "Checking the experience"):
 *
 * - in the light and the dark colour scheme, a screenshot compared exactly with
 *   the committed one (tests/journeys/screenshots/), and an accessibility scan;
 * - text drawn only in the bundled fonts, every character covered by them, and
 *   drawn only once they have loaded;
 * - no error in the browser console and no request to anywhere but the app;
 * - the journey so far done with the keyboard only.
 *
 * Journeys move with `press`, `type` and `activate`, which use the keyboard.
 * Anything else that reaches the page as input (a click, a tap, a mouse wheel,
 * text filled in without typing it) fails the journey at its next step.
 *
 * What could vary is fixed at its source: the viewport, locale, timezone,
 * colour scheme, motion and the browser's rendering are set in
 * playwright.config.ts, fonts come only from the app, and the page's clock is
 * fixed here.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test as base, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
	journeySlug,
	SCREENSHOT_ANNOTATION,
	SCREENSHOT_COPY_VARIABLE,
	SCREENSHOT_DIRECTORY,
	screenshotMode,
	screenshotName,
	stepSlug,
	THEMES
} from '../../scripts/journey-screenshots.ts';
import { comparePngPixels } from '../../scripts/png-pixels.ts';
import { expectAccessible } from './accessibility.ts';

export { expect } from '@playwright/test';

/** The time the page's clock shows for the whole journey. */
export const JOURNEY_TIME = new Date('2026-01-15T09:30:00Z');

/** The only font families text may be drawn in: the ones bundled with the app. */
const BUNDLED_FONTS: readonly string[] = ['Inter', 'JetBrains Mono'];

/**
 * How the images are handled, set by `pnpm journeys:*` (scripts/journeys.ts):
 * compared with the committed ones (the default), or written where they changed.
 */
const MODE = screenshotMode(process.env);

/** For the determinism check: a directory to copy every screenshot into, as taken. */
const COPY_DIRECTORY = process.env[SCREENSHOT_COPY_VARIABLE];

/** The committed images are Linux images (README, "Checking the experience"). */
export const COMPARES_SCREENSHOTS = process.platform === 'linux';

/** Most Tab presses `activate` makes looking for its target. */
const MAX_TABS = 200;

/** Most screenshots taken while waiting for the screen to stop changing. */
const MAX_SHOTS = 10;

/** Laid over the page for each screenshot: nothing moves and nothing blinks. */
const SCREENSHOT_CSS = `
*, *::before, *::after {
	animation: none !important;
	transition: none !important;
	caret-color: transparent !important;
}`;

const REPOSITORY = join(import.meta.dirname, '..', '..');

export interface Journey {
	/** The page, for reading it: locate by role and visible label, never by test id. */
	readonly page: Page;
	/** Opens a page of the app by its address, as a person does from a link. */
	open(path: string): Promise<void>;
	/** Checks the screen as it is now, as the next numbered step (see above). */
	step(name: string): Promise<void>;
	/** Presses a key or a combination, such as `Tab` or `Shift+Tab`. */
	press(key: string): Promise<void>;
	/** Types text key by key into what has focus. */
	type(text: string): Promise<void>;
	/** Moves focus to the target with Tab, as a keyboard user does, then presses `key`. */
	activate(target: Locator, key?: string): Promise<void>;
	/**
	 * What Tab reaches on the screen, from the top, in order, each as its role
	 * and accessible name: `link "Start reviewing"`.
	 */
	tabOrder(): Promise<readonly string[]>;
}

/** Reports input that did not come from the keyboard, through `__journeyInput`. */
function inputGuard(): void {
	const report = (text: string): void => {
		const send: unknown = Reflect.get(window, '__journeyInput');
		if (typeof send === 'function') void Reflect.apply(send, window, [text]);
	};
	for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel']) {
		window.addEventListener(
			type,
			(event) => {
				if (event.isTrusted) report(`a ${type} event`);
			},
			true
		);
	}
	// Typing a character sends keydown, then input, then keyup. Text that arrives
	// with no key held was put there some other way, such as `fill`.
	let keyDown = false;
	window.addEventListener('keydown', () => (keyDown = true), true);
	window.addEventListener('keyup', () => (keyDown = false), true);
	window.addEventListener(
		'input',
		(event) => {
			if (event.isTrusted && !keyDown) report('text entered without typing it');
		},
		true
	);
}

/** Waits until the bundled fonts are loaded and the page has drawn twice since. */
async function settle(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await document.fonts.ready;
	});
}

/** Every element with text of its own whose text is drawn in a font that is not bundled. */
async function fontsNotBundled(page: Page): Promise<readonly string[]> {
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('DOM.enable');
		await cdp.send('CSS.enable');
		const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		type Node = typeof root;
		const withText: Node[] = [];
		const visit = (node: Node, inHead: boolean): void => {
			const head = inHead || node.nodeName === 'HEAD';
			const ownText = (node.children ?? []).some(
				(child) => child.nodeType === 3 && child.nodeValue.trim() !== ''
			);
			if (!head && node.nodeType === 1 && ownText) withText.push(node);
			for (const child of node.children ?? []) visit(child, head);
		};
		visit(root, false);
		const problems: string[] = [];
		for (const node of withText) {
			const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
			for (const font of fonts) {
				if (!font.isCustomFont || !BUNDLED_FONTS.includes(font.familyName)) {
					problems.push(
						`<${node.localName}> has ${String(font.glyphCount)} character(s) drawn in an ` +
							`installed font ("${font.familyName}"), not in one of the app's web fonts. ` +
							`Give it a font-family of ${BUNDLED_FONTS.map((f) => `'${f}'`).join(' or ')}.`
					);
				}
			}
		}
		return problems;
	} finally {
		await cdp.detach();
	}
}

/**
 * Every character on the page that no bundled font face of its element's family
 * covers. Such a character is drawn as a missing-glyph box here, and in a
 * person's browser in some system font, so it must not appear.
 */
async function charactersNotCovered(page: Page): Promise<readonly string[]> {
	return page.evaluate(() => {
		const ranges = new Map<string, [number, number][]>();
		for (const face of document.fonts) {
			const family = face.family.replace(/^["']|["']$/g, '');
			const list = ranges.get(family) ?? [];
			for (const part of face.unicodeRange.split(',')) {
				const [low = '', high = low] = part.trim().replace(/^U\+/i, '').split('-');
				const from = parseInt(low.replace(/\?/g, '0'), 16);
				const to = parseInt(high.replace(/\?/g, 'F'), 16);
				if (Number.isFinite(from) && Number.isFinite(to)) list.push([from, to]);
			}
			ranges.set(family, list);
		}
		const problems: string[] = [];
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			const element = node.parentElement;
			if (element === null) continue;
			const family = getComputedStyle(element)
				.fontFamily.split(',')[0]
				?.trim()
				.replace(/^["']|["']$/g, '');
			const covered = ranges.get(family ?? '') ?? [];
			const missing = new Set<string>();
			for (const char of node.textContent ?? '') {
				if (/\s/.test(char)) continue;
				const code = char.codePointAt(0) ?? 0;
				if (!covered.some(([from, to]) => code >= from && code <= to)) missing.add(char);
			}
			if (missing.size > 0) {
				problems.push(
					`<${element.localName}> shows ${[...missing].map((c) => `"${c}"`).join(', ')}, ` +
						`which no bundled font face of "${family ?? ''}" covers. Use characters the bundled ` +
						'fonts have, or bundle a font that has them.'
				);
			}
		}
		return problems;
	});
}

/** A screenshot taken once the screen has stopped changing. */
async function stableScreenshot(page: Page): Promise<Buffer> {
	const shoot = (): Promise<Buffer> =>
		page.screenshot({
			fullPage: true,
			animations: 'disabled',
			caret: 'hide',
			scale: 'css',
			style: SCREENSHOT_CSS
		});
	let previous = await shoot();
	for (let n = 1; n < MAX_SHOTS; n += 1) {
		const next = await shoot();
		if (comparePngPixels(previous, next).kind === 'Same') return next;
		previous = next;
	}
	throw new Error(
		`The screen kept changing across ${String(MAX_SHOTS)} screenshots. Something on it moves ` +
			'or keeps loading; stop it, or wait in the journey for what it is waiting on.'
	);
}

/** Compares a screenshot with its committed image, or writes it in update mode. */
async function checkScreenshot(
	testInfo: TestInfo,
	fileName: string,
	label: string,
	shot: Buffer
): Promise<string | undefined> {
	testInfo.annotations.push({ type: SCREENSHOT_ANNOTATION, description: fileName });
	if (COPY_DIRECTORY !== undefined) {
		const copy = join(COPY_DIRECTORY, String(testInfo.repeatEachIndex), fileName);
		await mkdir(dirname(copy), { recursive: true });
		await writeFile(copy, shot);
	}
	if (!COMPARES_SCREENSHOTS) return undefined;

	const committed = join(REPOSITORY, SCREENSHOT_DIRECTORY, fileName);
	const relative = `${SCREENSHOT_DIRECTORY}/${fileName}`;
	const exists = existsSync(committed);
	const comparison = exists ? comparePngPixels(await readFile(committed), shot) : undefined;
	if (MODE === 'update') {
		if (comparison?.kind !== 'Same') {
			await mkdir(dirname(committed), { recursive: true });
			await writeFile(committed, shot);
		}
		return undefined;
	}
	if (comparison === undefined) {
		return (
			`${label} has no committed screenshot (${relative}). Run pnpm journeys:update to make ` +
			'it, look at the image, and commit it.'
		);
	}
	if (comparison.kind === 'Same') return undefined;
	const actual = testInfo.outputPath(fileName);
	const diff = testInfo.outputPath(fileName.replace(/\.png$/, '.diff.png'));
	await writeFile(actual, shot);
	await writeFile(diff, comparison.diff);
	await testInfo.attach(`${fileName} (now)`, { path: actual, contentType: 'image/png' });
	await testInfo.attach(`${fileName} (differences)`, { path: diff, contentType: 'image/png' });
	const sizes =
		comparison.expectedSize === comparison.actualSize
			? ''
			: ` The size changed from ${comparison.expectedSize} to ${comparison.actualSize}.`;
	return (
		`${label} no longer matches ${relative}: ${String(comparison.pixels)} pixel(s) differ.${sizes} ` +
		`The new screenshot is ${actual}, the differences in magenta in ${diff}. If the change is ` +
		'intended, run pnpm journeys:update and commit the new image.'
	);
}

export const test = base.extend<{ journey: Journey }>({
	journey: async ({ page, baseURL }, use, testInfo) => {
		const journeyName = journeySlug(testInfo.file);
		const inputProblems: string[] = [];
		const browserErrors: string[] = [];
		let steps = 0;

		await page.exposeFunction('__journeyInput', (text: unknown) => {
			inputProblems.push(String(text));
		});
		await page.addInitScript(inputGuard);
		await page.clock.setFixedTime(JOURNEY_TIME);
		page.on('console', (message) => {
			if (message.type() === 'error') browserErrors.push(`console error: ${message.text()}`);
		});
		page.on('pageerror', (error) => {
			browserErrors.push(`uncaught error: ${error.message}`);
		});
		// Nothing is fetched from anywhere but the app: no fonts, scripts or images
		// from the network, which could change or fail.
		const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
		await page.context().route(
			(url) => url.origin !== origin && url.protocol !== 'data:' && url.protocol !== 'blob:',
			async (route) => {
				browserErrors.push(`request to ${route.request().url()}, outside the app`);
				await route.abort();
			}
		);

		const keyboardOnly = (): void => {
			if (inputProblems.length === 0) return;
			const seen = [...new Set(inputProblems)].join(', ');
			inputProblems.length = 0;
			throw new Error(
				`The journey reached the page with ${seen}. Journeys use the keyboard only ` +
					'(README, "Checking the experience"): move with journey.press, journey.type and ' +
					'journey.activate instead of click, fill, hover or the mouse.'
			);
		};

		const journey: Journey = {
			page,
			async open(path) {
				await page.goto(path);
			},
			async step(name) {
				keyboardOnly();
				const slug = stepSlug(name);
				if (!slug.ok) {
					throw new Error(
						`"${name}" cannot name a step: use a few plain words, such as "Start page".`
					);
				}
				steps += 1;
				const number = steps;
				const label = `Step ${String(number)}, "${name}"`;
				await base.step(label, async () => {
					const problems: string[] = [];
					for (const theme of THEMES) {
						await page.emulateMedia({ colorScheme: theme });
						await settle(page);
						if (theme === THEMES[0]) {
							problems.push(...(await fontsNotBundled(page)));
							problems.push(...(await charactersNotCovered(page)));
						}
						const shot = await stableScreenshot(page);
						const file = screenshotName(journeyName, number, slug.value, theme);
						const problem = await checkScreenshot(testInfo, file, `${label} (${theme})`, shot);
						if (problem !== undefined) problems.push(problem);
						await expectAccessible(page);
					}
					await page.emulateMedia({ colorScheme: THEMES[0] });
					problems.push(...browserErrors.splice(0));
					if (problems.length > 0) throw new Error(problems.join('\n\n'));
				});
			},
			async press(key) {
				await page.keyboard.press(key);
			},
			async type(text) {
				await page.keyboard.type(text);
			},
			async activate(target, key = 'Enter') {
				for (let n = 0; n < MAX_TABS; n += 1) {
					if (await target.evaluate((element) => element === document.activeElement)) {
						await page.keyboard.press(key);
						return;
					}
					await page.keyboard.press('Tab');
				}
				throw new Error(
					`${String(target)} could not be reached with Tab in ${String(MAX_TABS)} presses. ` +
						'Everything a person can do must be reachable by keyboard.'
				);
			},
			async tabOrder() {
				await page.evaluate(() => {
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
				});
				const order: string[] = [];
				const focused = page.locator(':focus');
				for (let n = 0; n < MAX_TABS; n += 1) {
					await page.keyboard.press('Tab');
					if ((await focused.count()) === 0) break;
					const name = (await focused.ariaSnapshot()).replace(/^- /, '').split('\n')[0] ?? '';
					if (name === order[0]) break;
					order.push(name);
				}
				return order;
			}
		};

		await use(journey);

		keyboardOnly();
		// Said only of a journey that otherwise passed, so it never hides the real failure.
		if (steps === 0 && testInfo.status === 'passed') {
			throw new Error(
				'This journey has no steps. Call journey.step on every screen it reaches, so each is ' +
					'checked and has a committed screenshot.'
			);
		}
	}
});
