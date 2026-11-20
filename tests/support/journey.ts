/**
 * The journey helper. Every journey is written with it (lint allows no other
 * `test` in tests/journeys), as named steps:
 *
 *     test('J1 Something', async ({ journey }) => {
 *         await journey.open('/');
 *         await journey.step('Start page');
 *         await journey.activate(journey.byRole('button', { name: 'Start reviewing' }));
 *         await journey.step('First section');
 *     });
 *
 * One `step` call does everything that must hold on every screen, so a journey
 * cannot leave part of it out (README, "Checking the experience"):
 *
 * - in the light and the dark colour scheme, a screenshot of the viewport, what a
 *   person sees at that moment, compared exactly with the committed one
 *   (tests/journeys/screenshots/), and an accessibility scan of the whole page. A
 *   journey that needs to show more scrolls with the keyboard and takes another
 *   step, so a step costs about the same however long the page is;
 * - in both schemes too, text drawn only in the bundled fonts, every character
 *   covered by them, italic and bold text each in a bundled face of its own (the
 *   app never fakes one), and drawn only once they have loaded;
 * - no error in the browser console and no request to anywhere but the app,
 *   checked again when the journey finishes.
 *
 * A journey gets no Playwright page, context or locator: only the `Journey`
 * below. It finds things as a person does, by role, visible text or label, and
 * gets back a `Target`, which it can activate, check or read, nothing more. It
 * moves with `press`, `type` and `activate`, which use the keyboard; the two
 * things a person does outside the page have their own helpers, `readClipboard`
 * and `chooseFiles`. Lint closes the rest (scripts/eslint-journey-rules.ts), so a
 * journey is kept to the keyboard by what it is given, and the page is left to
 * do whatever the app does: fill in fields, change them later, click its own
 * hidden file input.
 *
 * What could vary is fixed at its source: the viewport, locale, timezone,
 * colour scheme, motion and the browser's rendering are set in
 * playwright.config.ts, fonts come only from the app, and the page's clock is
 * fixed here.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	expect,
	test as base,
	type JSHandle,
	type Locator,
	type Page,
	type TestInfo
} from '@playwright/test';
import {
	journeySlug,
	SCREENSHOT_ANNOTATION,
	SCREENSHOT_COPY_VARIABLE,
	SCREENSHOT_DIRECTORY,
	screenshotMode,
	screenshotName,
	stepSlug,
	THEMES,
	type Theme
} from '../../scripts/journey-screenshots.ts';
import { comparePngPixels } from '../../scripts/png-pixels.ts';
import { stepNumberOf } from '../../src/lib/core/step-number.tiny.ts';
import { expectAccessible } from './accessibility.ts';

export { expect };

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

/** The roles `byRole` takes, as Playwright names them. */
export type Role = Parameters<Page['getByRole']>[0];

/**
 * Something on the page a journey found by role, text or label. Opaque: the
 * journey can hand it back to the helper, and nothing else.
 */
export interface Target {
	/** How it was found, for messages: `button "Start reviewing"`. */
	readonly description: string;
}

/** Each target's locator, kept from the journey. */
const LOCATORS = new WeakMap<Target, Locator>();

function makeTarget(locator: Locator, description: string): Target {
	const target: Target = Object.freeze({ description });
	LOCATORS.set(target, locator);
	return target;
}

function locatorOf(target: Target): Locator {
	const locator = LOCATORS.get(target);
	if (locator === undefined) {
		throw new Error(
			`${target.description} was not found by the journey helper. Find it with ` +
				'journey.byRole, journey.byText or journey.byLabel.'
		);
	}
	return locator;
}

export interface Journey {
	/** Opens a page of the app by its address, as a person does from a link. */
	open(path: string): Promise<void>;
	/** Checks the screen as it is now, as the next numbered step (see above). */
	step(name: string): Promise<void>;
	/** Presses a key or a combination, such as `Tab` or `Shift+Tab`. */
	press(key: string): Promise<void>;
	/** Types text key by key into what has focus. */
	type(text: string): Promise<void>;
	/** Moves focus to the target with Tab, as a keyboard user does, then presses `key`. */
	activate(target: Target, key?: string): Promise<void>;
	/**
	 * What Tab reaches on the screen, from the top, in order, each as its role
	 * and accessible name: `link "Start reviewing"`.
	 */
	tabOrder(): Promise<readonly string[]>;

	/** What has this role and, if given, this accessible name or heading level. */
	byRole(
		role: Role,
		options?: { readonly name?: string | RegExp; readonly level?: number; readonly exact?: boolean }
	): Target;
	/** What shows this text. */
	byText(text: string | RegExp, options?: { readonly exact?: boolean }): Target;
	/** The form control with this label. */
	byLabel(text: string | RegExp, options?: { readonly exact?: boolean }): Target;

	/** Waits until the target is on the screen, and fails if it never is. */
	expectVisible(target: Target): Promise<void>;
	/** Waits until the target is gone from the screen, and fails if it stays. */
	expectHidden(target: Target): Promise<void>;
	/** The text the target shows. */
	textOf(target: Target): Promise<string>;
	/** The page's title, as the browser tab shows it. */
	title(): Promise<string>;

	/** What the app put on the clipboard, read as a person pasting it elsewhere would. */
	readClipboard(): Promise<string>;
	/**
	 * Opens the file chooser by activating the target with the keyboard, then picks
	 * these files in it, as a person does in the system's dialog.
	 */
	chooseFiles(target: Target, files: readonly string[], key?: string): Promise<void>;
}

/**
 * An element's role and accessible name, as a screen reader announces it:
 * `link "Start reviewing"`. The first line of its ARIA snapshot, without the
 * colon that introduces its children (a link's address, a list's items).
 */
async function roleAndName(locator: Locator): Promise<string> {
	const first = (await locator.ariaSnapshot()).split('\n')[0] ?? '';
	return first.replace(/^- /, '').replace(/:$/, '');
}

/** Waits until the bundled fonts are loaded and the page has drawn twice since. */
async function settle(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await document.fonts.ready;
	});
}

/**
 * Every element with text of its own whose text is drawn in a font that is not
 * bundled. The walk goes into shadow roots, the browser's own included (where a
 * field's value and placeholder, a text area's text and a select's choice are
 * drawn), into same-origin frames, and through SVG. What it cannot see is text
 * painted on a canvas: that is pixels, with no font to ask about.
 */
async function fontsNotBundled(page: Page): Promise<readonly string[]> {
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('DOM.enable');
		await cdp.send('CSS.enable');
		const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		type Node = typeof root;
		interface WithText {
			readonly node: Node;
			/** The element a person sees: the <input>, not the browser's <div> inside it. */
			readonly host: Node;
			/** Inside a shadow root the browser made for a form control. */
			readonly inControl: boolean;
			readonly text: string;
		}
		const withText: WithText[] = [];
		const visit = (node: Node, inHead: boolean, host: Node | undefined): void => {
			const head = inHead || node.nodeName === 'HEAD';
			const text = (node.children ?? [])
				.filter((child) => child.nodeType === 3)
				.map((child) => child.nodeValue)
				.join('');
			if (!head && node.nodeType === 1 && text.trim() !== '') {
				withText.push({ node, host: host ?? node, inControl: host !== undefined, text });
			}
			const inner = [
				...(node.children ?? []),
				...(node.pseudoElements ?? []),
				...(node.contentDocument === undefined ? [] : [node.contentDocument])
			];
			for (const child of inner) visit(child, head, host);
			for (const shadow of node.shadowRoots ?? []) {
				visit(shadow, head, shadow.shadowRootType === 'user-agent' ? (host ?? node) : host);
			}
		};
		visit(root, false, undefined);

		// Which font draws a character depends only on the element's font settings and
		// the character, so one element is asked about for each pair of the two that
		// appears, not every element: on a long page, a few dozen instead of thousands.
		// One snapshot gives every element's font settings; it leaves out the
		// browser's own shadow roots, so text inside a form control is always asked about.
		const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
			computedStyles: ['font-family', 'font-style', 'font-weight', 'font-stretch']
		});
		const settings = new Map<number, string>();
		for (const doc of snapshot.documents) {
			const ids = doc.nodes.backendNodeId ?? [];
			doc.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
				const id = ids[nodeIndex];
				const styles = doc.layout.styles[layoutIndex] ?? [];
				if (id !== undefined) {
					settings.set(id, styles.map((index) => snapshot.strings[index] ?? '').join('|'));
				}
			});
		}
		const seen = new Set<string>();
		const asked = withText.filter(({ node, inControl, text }) => {
			const key = settings.get(node.backendNodeId);
			if (inControl || key === undefined) return true;
			let added = false;
			for (const char of text) {
				if (/\s/.test(char)) continue;
				const pair = `${key}\u0000${char}`;
				if (seen.has(pair)) continue;
				seen.add(pair);
				added = true;
			}
			return added;
		});

		const problems: string[] = [];
		// Every question is sent at once and answered in one go, not one round trip each.
		const answers = await Promise.all(
			asked.map(({ node }) => cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId }))
		);
		for (const [index, { fonts }] of answers.entries()) {
			const host = asked[index]?.host;
			if (host === undefined) continue;
			for (const font of fonts) {
				if (!font.isCustomFont || !BUNDLED_FONTS.includes(font.familyName)) {
					problems.push(
						`<${host.localName}> has ${String(font.glyphCount)} character(s) drawn in an ` +
							`installed font ("${font.familyName}"), not in one of the app's web fonts. ` +
							`Give it a font-family of ${BUNDLED_FONTS.map((f) => `'${f}'`).join(' or ')}` +
							(FORM_CONTROLS.includes(host.localName)
								? `, or font: inherit, as src/app.css does for every form control.`
								: '.')
					);
				}
			}
		}
		return [...new Set(problems)];
	} finally {
		await cdp.detach();
	}
}

/** Elements the browser draws with its own font unless told to inherit the page's. */
const FORM_CONTROLS: readonly string[] = ['button', 'input', 'select', 'textarea', 'option'];

/**
 * Every character on the page that no bundled font face of its element's family
 * covers. Such a character is drawn as a missing-glyph box here, and in a
 * person's browser in some system font, so it must not appear. Like the font
 * check it reads fields' values and placeholders, open shadow roots, same-origin
 * frames and SVG; a canvas it cannot read.
 */
async function charactersNotCovered(page: Page): Promise<readonly string[]> {
	return page.evaluate(() => {
		const problems: string[] = [];
		const unquote = (family: string): string => family.trim().replace(/^["']|["']$/g, '');
		const check = (doc: Document, root: Node): void => {
			const ranges = new Map<string, [number, number][]>();
			for (const face of doc.fonts) {
				const family = unquote(face.family);
				const list = ranges.get(family) ?? [];
				for (const part of face.unicodeRange.split(',')) {
					const [low = '', high = low] = part.trim().replace(/^U\+/i, '').split('-');
					const from = parseInt(low.replace(/\?/g, '0'), 16);
					const to = parseInt(high.replace(/\?/g, 'F'), 16);
					if (Number.isFinite(from) && Number.isFinite(to)) list.push([from, to]);
				}
				ranges.set(family, list);
			}
			const faces = [...doc.fonts];
			/** Whether a face of the family has this style and weight, so the browser need not fake one. */
			const hasFace = (family: string, style: string, weight: number): boolean =>
				faces.some((face) => {
					if (unquote(face.family) !== family) return false;
					const italic = face.style !== 'normal';
					if (italic !== (style !== 'normal')) return false;
					const [low = 0, high = low] = face.weight.split(/\s+/).map(Number);
					return weight >= low && weight <= high;
				});
			const report = (element: Element, text: string, pseudo?: string): void => {
				const style = getComputedStyle(element, pseudo);
				const family = unquote(style.fontFamily.split(',')[0] ?? '');
				const weight = Number(style.fontWeight);
				if (text.trim() !== '' && ranges.has(family) && !hasFace(family, style.fontStyle, weight)) {
					// With font-synthesis: none the browser draws it in the nearest face it has,
					// so the emphasis does not show.
					const shape = `${style.fontStyle === 'normal' ? '' : `${style.fontStyle} `}${String(weight)}`;
					problems.push(
						`<${element.localName}> is set in ${shape} "${family}", but no bundled face of ` +
							`"${family}" is ${shape}, so the browser draws it in another face and the ` +
							'emphasis does not show. Bundle that face (src/routes/+layout.svelte), or ' +
							'use a weight and style that is bundled.'
					);
				}
				const covered = ranges.get(family) ?? [];
				const missing = new Set<string>();
				for (const char of text) {
					if (/\s/.test(char)) continue;
					const code = char.codePointAt(0) ?? 0;
					if (!covered.some(([from, to]) => code >= from && code <= to)) missing.add(char);
				}
				if (missing.size > 0) {
					problems.push(
						`<${element.localName}> shows ${[...missing].map((c) => `"${c}"`).join(', ')}, ` +
							`which no bundled font face of "${family}" covers. Use characters the bundled ` +
							'fonts have, or bundle a font that has them.'
					);
				}
			};
			const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
				if (node.nodeType === Node.TEXT_NODE) {
					const element = node.parentElement;
					if (element !== null) report(element, node.textContent ?? '');
					continue;
				}
				if (!(node instanceof Element)) continue;
				if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
					if (node.type !== 'hidden' && node.type !== 'password') report(node, node.value);
					report(node, node.placeholder, '::placeholder');
				}
				if (node.shadowRoot !== null) check(doc, node.shadowRoot);
				if (node instanceof HTMLIFrameElement) {
					try {
						const inner = node.contentDocument;
						if (inner?.body) check(inner, inner.body);
					} catch {
						// Another origin's frame: not the app's to check.
					}
				}
			}
		};
		check(document, document.body);
		return [...new Set(problems)];
	});
}

/** A screenshot taken once the screen has stopped changing. */
async function stableScreenshot(page: Page): Promise<Buffer> {
	const shoot = (): Promise<Buffer> =>
		page.screenshot({
			// What a person sees at this moment: the viewport. To show more, a journey
			// scrolls with the keyboard and takes another step.
			fullPage: false,
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

/** How a journey's steps treat their screenshots. */
export interface JourneyOptions {
	/**
	 * `check`, for every journey: compared with the committed images (or written,
	 * in update mode). `take`, for the helper's own tests: taken as a step takes
	 * them, but neither compared nor kept.
	 */
	readonly screenshots: 'check' | 'take';
}

/** A journey on a page, and what must hold once it has finished. */
export interface RunningJourney {
	readonly journey: Journey;
	/** Fails if anything since the last step broke the rules a step checks. */
	finish(): Promise<void>;
}

/**
 * Sets up a journey on a fresh page: the fixed clock and the
 * watch on browser errors and outside requests. The `journey` fixture uses it;
 * so do the helper's own tests, on pages they make.
 */
export async function startJourney(
	page: Page,
	testInfo: TestInfo,
	baseURL: string | undefined,
	options: JourneyOptions = { screenshots: 'check' }
): Promise<RunningJourney> {
	const journeyName = journeySlug(testInfo.file);
	const browserErrors: string[] = [];
	let steps = 0;

	await page.clock.setFixedTime(JOURNEY_TIME);
	const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
	// The app may copy to the clipboard, as a person lets it, and the journey read it back.
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
	page.on('console', (message) => {
		if (message.type() === 'error') browserErrors.push(`console error: ${message.text()}`);
	});
	page.on('pageerror', (error) => {
		browserErrors.push(`uncaught error: ${error.message}`);
	});
	// Nothing is fetched from anywhere but the app: no fonts, scripts or images
	// from the network, which could change or fail.
	await page.context().route(
		(url) => url.origin !== origin && url.protocol !== 'data:' && url.protocol !== 'blob:',
		async (route) => {
			browserErrors.push(`request to ${route.request().url()}, outside the app`);
			await route.abort();
		}
	);

	const isFocused = (target: Target): Promise<boolean> =>
		locatorOf(target).evaluate((element) => element === document.activeElement);

	const activate = async (target: Target, key = 'Enter'): Promise<void> => {
		for (let n = 0; n < MAX_TABS; n += 1) {
			if (await isFocused(target)) {
				await page.keyboard.press(key);
				return;
			}
			await page.keyboard.press('Tab');
		}
		throw new Error(
			`${target.description} could not be reached with Tab in ${String(MAX_TABS)} presses. ` +
				'Everything a person can do must be reachable by keyboard.'
		);
	};

	const described = (
		kind: string,
		what: string | RegExp,
		options: Readonly<Record<string, unknown>> = {}
	): string => {
		const extra = Object.entries(options)
			.map(([key, value]) => `${key}: ${String(value)}`)
			.join(', ');
		return `${kind} ${typeof what === 'string' ? `"${what}"` : String(what)}${extra === '' ? '' : ` (${extra})`}`;
	};

	const journey: Journey = {
		async open(path) {
			await page.goto(path);
		},
		async step(name) {
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
				// Fonts and characters in both schemes: a theme can change the font too.
				const fontProblems = new Map<string, Theme[]>();
				for (const theme of THEMES) {
					await page.emulateMedia({ colorScheme: theme });
					await settle(page);
					for (const problem of [
						...(await fontsNotBundled(page)),
						...(await charactersNotCovered(page))
					]) {
						fontProblems.set(problem, [...(fontProblems.get(problem) ?? []), theme]);
					}
					const shot = await stableScreenshot(page);
					if (options.screenshots === 'check') {
						const file = screenshotName(journeyName, stepNumberOf(number), slug.value, theme);
						const problem = await checkScreenshot(testInfo, file, `${label} (${theme})`, shot);
						if (problem !== undefined) problems.push(problem);
					}
					await expectAccessible(page);
				}
				await page.emulateMedia({ colorScheme: THEMES[0] });
				for (const [problem, themes] of fontProblems) {
					problems.push(`(${themes.join(' and ')}) ${problem}`);
				}
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
		activate,
		async tabOrder() {
			await page.evaluate(() => {
				if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
			});
			const order: string[] = [];
			const focused = page.locator(':focus');
			// Tab has come round again when the first element it reached has focus again:
			// the same element, not one with the same name.
			let first: JSHandle | undefined;
			try {
				for (let n = 0; n < MAX_TABS; n += 1) {
					await page.keyboard.press('Tab');
					if ((await focused.count()) === 0) break;
					if (first === undefined) {
						first = await page.evaluateHandle(() => document.activeElement);
					} else if (await first.evaluate((element) => element === document.activeElement)) {
						break;
					}
					order.push(await roleAndName(focused));
				}
			} finally {
				await first?.dispose();
			}
			return order;
		},
		byRole(role, options = {}) {
			return makeTarget(
				page.getByRole(role, options),
				described(role, options.name ?? '', {
					...(options.level === undefined ? {} : { level: options.level })
				})
			);
		},
		byText(text, options = {}) {
			return makeTarget(page.getByText(text, options), described('text', text));
		},
		byLabel(text, options = {}) {
			return makeTarget(page.getByLabel(text, options), described('field labelled', text));
		},
		async expectVisible(target) {
			await expect(
				locatorOf(target),
				`${target.description} should be on the screen`
			).toBeVisible();
		},
		async expectHidden(target) {
			await expect(
				locatorOf(target),
				`${target.description} should not be on the screen`
			).toBeHidden();
		},
		async textOf(target) {
			return locatorOf(target).innerText();
		},
		async title() {
			return page.title();
		},
		async readClipboard() {
			return page.evaluate(() => navigator.clipboard.readText());
		},
		async chooseFiles(target, files, key = 'Enter') {
			const chooser = page.waitForEvent('filechooser');
			await activate(target, key);
			await (await chooser).setFiles([...files]);
		}
	};

	return {
		journey,
		async finish() {
			// What the page did after the last step counts as much as what it did before.
			await settle(page);
			const late = browserErrors.splice(0);
			if (late.length > 0) {
				throw new Error(
					`After the last step: ${late.join('; ')}. The page must log no errors and fetch ` +
						'nothing from outside the app at any time; fix what caused it.'
				);
			}
			// Said only of a journey that otherwise passed, so it never hides the real failure.
			if (steps === 0 && testInfo.status === 'passed') {
				throw new Error(
					'This journey has no steps. Call journey.step on every screen it reaches, so each is ' +
						'checked and has a committed screenshot.'
				);
			}
		}
	};
}

export const test = base.extend<{ journey: Journey }>({
	journey: async ({ page, baseURL }, use, testInfo) => {
		const running = await startJourney(page, testInfo, baseURL);
		await use(running.journey);
		await running.finish();
	}
});
