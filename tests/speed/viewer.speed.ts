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
		const review = page.getByRole('complementary', { name: 'Your review' });
		const group = page.getByRole('checkbox', { name: 'All reviewed: Not sorted yet' });
		await group.focus();
		const ticking = performance.now();
		await page.keyboard.press('Space');
		await expect(review).toContainText('Everything reviewed: 200,000 changes');
		record(testInfo, 'time to tick a group of 2,000 files', performance.now() - ticking, 1_000);
		// Everything is reviewed, and the page moved focus there; back to the group's box.
		await group.focus();
		partRequests = 0;
		const unticking = performance.now();
		await page.keyboard.press('Space');
		await expect(review).toContainText('Not started: 200,000 changes to review');
		await page.waitForFunction(
			() => document.querySelector('#part-0 td.code')?.textContent === 'old line 1',
			undefined,
			{ polling: 'raf' }
		);
		record(testInfo, 'time to untick a group of 2,000 files', performance.now() - unticking, 1_000);
		await expect.poll(() => inFlight).toBe(0);
		expect(mostInFlight).toBeLessThanOrEqual(PART_REQUESTS_AT_ONCE);
		expect(partRequests).toBeLessThan(100);
		await expect(page.getByText('diff delver is not answering')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	} finally {
		await world.close();
	}
});
