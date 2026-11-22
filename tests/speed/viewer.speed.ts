/**
 * The viewer's speed on a large diff (docs/DEVELOPING.md, "Checking the experience"): 2,000
 * files and 200,000 changed lines, opened in the journey browser against a
 * daemon of the test's own. Time to first readable content, time to move to
 * the next file and time to tick one are recorded against their guidance,
 * which `pnpm verify` reports when exceeded; time never fails the test.
 *
 * Not a journey: it reads the clock and the page directly and takes no
 * screenshots. Moving and ticking are timed inside the page, from the key to
 * the frame that shows the result, so the browser driver's own work is not
 * counted.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { MEASURED_TIME_ANNOTATION } from '../../scripts/test-timings.ts';
import { makeJourneyWorld } from '../support/journey-world.ts';
import { PART_REQUESTS_AT_ONCE } from '../../src/lib/ui/viewer/requests.ts';

function record(testInfo: TestInfo, what: string, ms: number, guidance: number): void {
	testInfo.annotations.push({
		type: MEASURED_TIME_ANNOTATION,
		description: JSON.stringify({ what, ms: Math.round(ms), guidance })
	});
}

/** What a part shows when it is ready: its first line of code, and, when asked, focus. */
interface Ready {
	readonly at: number;
	/** Its first line of code; undefined for a part that is put away. */
	readonly text?: string;
	readonly focused: boolean;
	readonly checked?: boolean;
}

/**
 * Presses `key` in the page, as its keyboard shortcuts hear it, and gives the
 * milliseconds until a frame shows the part ready.
 */
function timeKey(page: Page, key: string, ready: Ready): Promise<number> {
	return page.evaluate(
		({ key, ready }) =>
			new Promise<number>((resolve) => {
				const isReady = (): boolean => {
					const part = document.getElementById(`part-${String(ready.at)}`);
					const code = part?.querySelector('td.code');
					const toggle = document.getElementById(`part-${String(ready.at)}-toggle`);
					const box = part?.querySelector<HTMLInputElement>('input[type=checkbox]');
					return (
						(ready.text === undefined || code?.textContent === ready.text) &&
						(!ready.focused || document.activeElement === toggle) &&
						(ready.checked === undefined || box?.checked === ready.checked)
					);
				};
				const started = performance.now();
				(document.activeElement ?? document.body).dispatchEvent(
					new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
				);
				const look = (): void => {
					if (isReady()) resolve(performance.now() - started);
					else requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
			}),
		{ key, ready }
	);
}

/**
 * Presses Enter in the search box, as the person moving to the next match
 * does, and gives the milliseconds until a frame shows the match it moved to
 * marked on the screen and the count saying which it is, another than before.
 */
function timeNextMatch(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				const status = (): string => document.getElementById('search-status')?.textContent ?? '';
				const before = status();
				const started = performance.now();
				(document.activeElement ?? document.body).dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
				);
				const look = (): void => {
					const now = status().trim();
					const box = document.querySelector('mark.match.current')?.getBoundingClientRect();
					const shown = box !== undefined && box.top >= 0 && box.bottom <= window.innerHeight;
					if (now !== before.trim() && /^[0-9,]+ of /.test(now) && shown) {
						resolve(performance.now() - started);
					} else requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
			})
	);
}

/**
 * Clicks the element at `selector` in the page and gives the milliseconds
 * until a frame shows each selector's element starting with its text.
 */
function timeClick(
	page: Page,
	selector: string,
	ready: () => readonly (readonly [string, string])[]
): Promise<number> {
	return page.evaluate(
		({ selector, wanted }) =>
			new Promise<number>((resolve, reject) => {
				const target = document.querySelector<HTMLElement>(selector);
				if (target === null) {
					reject(new Error(`Nothing on the page matches ${selector}`));
					return;
				}
				const started = performance.now();
				target.click();
				const look = (): void => {
					const shown = wanted.every(([where, text]) =>
						(document.querySelector(where)?.textContent ?? '').trim().startsWith(text)
					);
					if (shown) resolve(performance.now() - started);
					else requestAnimationFrame(look);
				};
				requestAnimationFrame(look);
			}),
		{ selector, wanted: ready() }
	);
}

test('one change of 80,000 rows is shown and ticked quickly', async ({ page }, testInfo) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('long-file');
		const run = await world.command([], repo);
		await page.goto(run.address);
		const part = page.getByRole('article', { name: 'data/rows.txt' });
		await expect(part).toContainText('This is a large change: 80,000 lines.');
		await part.getByRole('button', { name: 'Show this large change' }).focus();
		// Shown: from the key to its first and last rows drawn.
		const showing = performance.now();
		await page.keyboard.press('Enter');
		await page.waitForFunction(
			() => document.querySelector('#part-0 td.code')?.textContent === 'old line 1',
			undefined,
			{ polling: 'raf' }
		);
		record(testInfo, 'time to show a change of 80,000 rows', performance.now() - showing, 1_000);
		// Ticked: from the key to the box shown ticked.
		// The only file: once ticked, everything is reviewed, and focus goes there.
		const ticked = await timeKey(page, 'r', { at: 0, focused: false, checked: true });
		record(testInfo, 'time to tick a change of 80,000 rows', ticked, 500);
		await expect(page.getByRole('complementary', { name: 'Your review' })).toContainText(
			'Everything reviewed: 80,000 changes'
		);
		// A match deep in it, now put away as reviewed: found, and reached with one key.
		await page.keyboard.press('/');
		await page.keyboard.type('new line 39999');
		await expect(page.locator('#search-status')).toHaveText(
			'1 match in 1 file. Press Enter to go to the first.'
		);
		const reached = await timeNextMatch(page);
		record(testInfo, 'time to reach a match deep in a change of 80,000 rows', reached, 1_500);
		await expect(page.locator('mark.match.current')).toHaveText('new line 39999');
		await page.keyboard.press('Escape');
		await page.keyboard.press('t');
		await expect(page.getByRole('option', { name: /data\/rows.txt/ })).toBeVisible();
		const openingFile = performance.now();
		await page.keyboard.press('Enter');
		const reader = page.getByRole('dialog', { name: 'data/rows.txt' });
		await expect(reader.locator('code').first()).toHaveText('new line 1');
		record(
			testInfo,
			'time to open a 40,000-line snapshot file',
			performance.now() - openingFile,
			750
		);
		await expect(reader.locator('code')).toHaveCount(200);
		await reader.getByRole('spinbutton', { name: 'Go to line' }).fill('39999');
		await reader.getByRole('button', { name: 'Go', exact: true }).press('Enter');
		await expect(reader.locator('code').last()).toHaveText('new line 40000');
		await expect(reader.locator('code')).toHaveCount(200);

		// A single dense line remains readable without a DOM node for every tab.
		await page.keyboard.press('Escape');
		await expect(reader).toBeHidden();
		await page.keyboard.press('t');
		await page.getByRole('combobox', { name: 'File name or path' }).fill('dense');
		await expect(page.getByRole('option', { name: 'data/dense.txt' })).toBeVisible();
		await page.keyboard.press('Enter');
		const dense = page.getByRole('dialog', { name: 'data/dense.txt' });
		await expect(dense.locator('code')).toHaveText(/^a\\x09.*end$/);
	} finally {
		await world.close();
	}
});

test('a diff of 2,000 files and 200,000 changed lines opens and moves at once', async ({
	page
}, testInfo) => {
	const world = await makeJourneyWorld();
	try {
		const repo = await world.repository('large');
		const run = await world.command([], repo);
		expect(run.output).toContain('2,000 files changed, 100,000 lines added and 100,000 removed');

		// First readable content: the first file's changed lines on the screen.
		const opening = performance.now();
		await page.goto(run.address);
		await page.waitForFunction(
			() => document.querySelector('#part-0 td.code')?.textContent === 'old line 1',
			undefined,
			{ polling: 'raf' }
		);
		record(
			testInfo,
			'time to first readable content, 2,000 files',
			performance.now() - opening,
			1_500
		);
		// Its colours, which come after it is readable, never before.
		await page.waitForFunction(
			() => document.querySelector('#part-0 td.code span[class^="code-"]') !== null,
			undefined,
			{ polling: 'raf' }
		);
		record(
			testInfo,
			'time to coloured code on the first screen, 2,000 files',
			performance.now() - opening,
			2_500
		);
		await expect(page.getByRole('complementary', { name: 'Your review' })).toContainText(
			'Not started: 200,000 changes to review'
		);

		// Moving to the next file: focus on it and its lines drawn. The slowest of several.
		await page.getByRole('button', { name: /^Start reviewing/ }).press('Enter');
		await expect(page.locator('#part-0-toggle')).toBeFocused();
		let slowest = 0;
		for (let at = 1; at <= 5; at += 1) {
			slowest = Math.max(
				slowest,
				await timeKey(page, 'j', { at, text: 'old line 1', focused: true })
			);
		}
		record(testInfo, 'time to move to the next file, 2,000 files', slowest, 200);

		// Ticking the file and seeing it ticked.
		// A ticked file is put away, so only its tick is looked for.
		const ticked = await timeKey(page, 'r', {
			at: 5,
			focused: true,
			checked: true
		});
		record(testInfo, 'time to tick a file, 2,000 files', ticked, 500);
		await expect(page.getByRole('complementary', { name: 'Your review' })).toContainText(
			'100 of 200,000 changes reviewed'
		);

		// Ticking and unticking the whole group: every part is opened again, but only
		// those near the screen fetch their lines, a few at a time, and none fails.
		let inFlight = 0;
		let mostInFlight = 0;
		let partRequests = 0;
		const isPart = (url: string): boolean => url.includes('/part?');
		page.on('request', (request) => {
			if (!isPart(request.url())) return;
			partRequests += 1;
			inFlight += 1;
			mostInFlight = Math.max(mostInFlight, inFlight);
		});
		const ended = (url: string): void => {
			if (isPart(url)) inFlight -= 1;
		};
		page.on('requestfinished', (request) => {
			ended(request.url());
		});
		page.on('requestfailed', (request) => {
			ended(request.url());
		});
		// Timed in the page, from the press to the frame that shows the result: a
		// locator's role query walks all 2,000 parts and would take longer than the page.
		const group = 'input[aria-label="All reviewed: Not sorted yet"]';
		const progress = '.rail .progress-text';
		const groupTicked = await timeClick(page, group, () => [
			['.rail .progress-text', 'Everything reviewed: 200,000 changes']
		]);
		record(testInfo, 'time to tick a group of 2,000 files', groupTicked, 1_000);
		partRequests = 0;
		const unticked = await timeClick(page, group, () => [
			[progress, 'Not started: 200,000 changes to review'],
			['#part-0 td.code', 'old line 1']
		]);
		record(testInfo, 'time to untick a group of 2,000 files', unticked, 1_000);
		await expect.poll(() => inFlight).toBe(0);
		expect(mostInFlight).toBeLessThanOrEqual(PART_REQUESTS_AT_ONCE);
		expect(partRequests).toBeLessThan(100);
		await expect(page.getByText('diff delver is not answering')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

		// Every file once: the by-file view, to its heading and first file drawn.
		const switched = await timeClick(page, '.switch button:last-child', () => [
			['#by-file-heading', 'Every file'],
			['.by-file li .path', 'src/module-00/file-0000.ts']
		]);
		record(testInfo, 'time to show every file, 2,000 files', switched, 500);
		await expect(page.getByRole('heading', { name: /^Every file/ })).toBeFocused();

		// Searching every file: from the last key typed to the count of matches shown.
		await page.keyboard.press('/');
		await expect(page.locator('#search-input')).toBeFocused();
		await page.keyboard.type('new line 3');
		const searching = performance.now();
		await page.keyboard.type('7');
		await page.waitForFunction(
			() =>
				(document.getElementById('search-status')?.textContent ?? '').startsWith(
					'2,000 matches in 2,000 files'
				),
			undefined,
			{ polling: 'raf' }
		);
		record(
			testInfo,
			'time from typing to search results, 2,000 files',
			performance.now() - searching,
			1_000
		);
		// From match to match, each in a file of its own whose lines may not be fetched yet.
		let slowestMatch = 0;
		for (let n = 1; n <= 5; n += 1) {
			slowestMatch = Math.max(slowestMatch, await timeNextMatch(page));
		}
		record(testInfo, 'time to move to the next match, 2,000 files', slowestMatch, 300);
		await page.keyboard.press('Escape');
		const openingFiles = performance.now();
		await page.keyboard.press('t');
		const name = page.getByRole('combobox', { name: 'File name or path' });
		await expect(name).toBeFocused();
		await expect(page.getByRole('option').first()).toBeVisible();
		record(
			testInfo,
			'time to open the file picker, 2,000 files',
			performance.now() - openingFiles,
			500
		);
		const matching = performance.now();
		await name.fill('m14f1499');
		await expect(page.getByRole('option').first()).toHaveText(/src\/module-14\/file-1499.ts/);
		record(
			testInfo,
			'time to match a fuzzy filename, 2,000 files',
			performance.now() - matching,
			500
		);
	} finally {
		await world.close();
	}
});

test('side by side, a diff of 2,000 files opens and moves at once, and a change of 80,000 rows shows quickly', async ({
	page
}, testInfo) => {
	const world = await makeJourneyWorld();
	try {
		const run = await world.command([], await world.repository('large'));
		await page.goto(run.address);
		await expect(page.locator('#part-0 td.code').first()).toHaveText('old line 1');
		// Side by side is remembered, so the page opened again shows it from the start.
		await page.keyboard.press('s');
		await expect(page.locator('table.split').first()).toBeVisible();
		const opening = performance.now();
		await page.reload();
		await page.waitForFunction(
			() => document.querySelector('#part-0 table.split td.code')?.textContent === 'old line 1',
			undefined,
			{ polling: 'raf' }
		);
		record(
			testInfo,
			'time to first readable content side by side, 2,000 files',
			performance.now() - opening,
			1_500
		);
		await page.getByRole('button', { name: /^Start reviewing/ }).press('Enter');
		await expect(page.locator('#part-0-toggle')).toBeFocused();
		let slowest = 0;
		for (let at = 1; at <= 5; at += 1) {
			slowest = Math.max(
				slowest,
				await timeKey(page, 'j', { at, text: 'old line 1', focused: true })
			);
		}
		record(testInfo, 'time to move to the next file side by side, 2,000 files', slowest, 200);
		const ticked = await timeKey(page, 'r', { at: 5, focused: true, checked: true });
		record(testInfo, 'time to tick a file side by side, 2,000 files', ticked, 500);

		// One change of 80,000 rows, side by side: 40,000 rows of pairs.
		const long = await world.command([], await world.repository('long-file'));
		await page.goto(long.address);
		const part = page.getByRole('article', { name: 'data/rows.txt' });
		await part.getByRole('button', { name: 'Show this large change' }).focus();
		const showing = performance.now();
		await page.keyboard.press('Enter');
		await page.waitForFunction(
			() => document.querySelector('#part-0 table.split td.code')?.textContent === 'old line 1',
			undefined,
			{ polling: 'raf' }
		);
		record(
			testInfo,
			'time to show a change of 80,000 rows side by side',
			performance.now() - showing,
			1_000
		);
	} finally {
		await world.close();
	}
});
