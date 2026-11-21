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
	} finally {
		await world.close();
	}
});
