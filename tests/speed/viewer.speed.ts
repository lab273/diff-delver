/**
 * The viewer's speed on a large diff (README, "Checking the experience"): 2,000
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
