import { createServer } from 'node:net';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { TIME_LIMITS, WAIT_HANG_TIMEOUTS } from './scripts/test-time-limits.ts';

/**
 * Journeys run against one production build (`build/`, made by `vite build`),
 * served by the Node adapter on a free port, in Chromium only.
 *
 * Playwright loads this file in the runner and again in every worker. The port is
 * chosen once, in the runner, and handed to the workers through the environment.
 */
const PORT_VARIABLE = 'DIFF_DELVER_JOURNEY_PORT';

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => {
				if (address !== null && typeof address === 'object') resolve(address.port);
				else reject(new Error('Could not find a free port for the journey server.'));
			});
		});
	});
}

const port = process.env[PORT_VARIABLE] ?? String(await freePort());
process.env[PORT_VARIABLE] = port;
const baseURL = `http://127.0.0.1:${port}`;

// A journey is held to time guidance, which `pnpm verify` reports as a warning. The
// timeout here is only the hang timeout, far above the guidance, so that a journey
// that hangs fails instead of blocking the run. Its own waits, for an `expect` and
// for the app to start, have hang timeouts too (scripts/test-time-limits.ts).
const HANG_TIMEOUT_MS = TIME_LIMITS.journey.hangTimeout;

/**
 * What the journey browser runs with, so the same commit draws the same pixels on
 * every run and every Linux machine (README, "Checking the experience").
 */
const DETERMINISTIC_CHROMIUM_ARGS = [
	// Glyph outlines unhinted and greyscale-antialiased, never shaped to the
	// machine's display: no hinting, no LCD subpixel text, no subpixel positioning.
	'--font-render-hinting=none',
	'--disable-lcd-text',
	'--disable-font-subpixel-positioning',
	// Colours in sRGB whatever the machine's display profile.
	'--force-color-profile=srgb',
	// Raster on the CPU with Skia's portable code, not code picked at run time for
	// this CPU's vector instructions, so a different processor draws the same.
	'--disable-gpu',
	'--disable-skia-runtime-opts',
	// The whole page drawn before a frame is shown, and no scrollbars.
	'--disable-partial-raster',
	'--run-all-compositor-stages-before-draw',
	'--hide-scrollbars',
	'--force-device-scale-factor=1'
];

export default defineConfig({
	// The journeys, and the journey helper's own tests (tests/support/journey.spec.ts).
	testDir: 'tests',
	testMatch: ['journeys/**/*.journey.ts', 'support/**/*.spec.ts'],
	timeout: HANG_TIMEOUT_MS,
	expect: { timeout: WAIT_HANG_TIMEOUTS.expectPolling },
	fullyParallel: true,
	// A committed `.only` would silently skip every other journey, here as in CI.
	forbidOnly: true,
	retries: 0,
	reporter: process.env['CI'] !== undefined ? [['list'], ['github']] : 'list',
	globalSetup: './tests/support/journey-global-setup.ts',
	use: {
		baseURL,
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// Headless with no channel: the pinned headless shell Playwright installs
				// for its version, never a system Chrome.
				headless: true,
				viewport: { width: 1280, height: 800 },
				deviceScaleFactor: 1,
				isMobile: false,
				hasTouch: false,
				locale: 'en-GB',
				timezoneId: 'UTC',
				colorScheme: 'light',
				reducedMotion: 'reduce',
				forcedColors: 'none',
				contrast: 'no-preference',
				launchOptions: {
					args: DETERMINISTIC_CHROMIUM_ARGS,
					env: {
						...process.env,
						FONTCONFIG_FILE: join(import.meta.dirname, 'tests/support/fontconfig/fonts.conf'),
						// The language and timezone of the browser process itself, not only
						// what the page is told. C.UTF-8 exists on every Linux machine.
						LANG: 'C.UTF-8',
						LC_ALL: 'C.UTF-8',
						TZ: 'UTC'
					}
				}
			}
		}
	],
	webServer: {
		command: 'node build',
		url: baseURL,
		reuseExistingServer: false,
		timeout: WAIT_HANG_TIMEOUTS.serverStart,
		stdout: 'ignore',
		stderr: 'pipe',
		env: { HOST: '127.0.0.1', PORT: port, ORIGIN: baseURL, TZ: 'UTC' }
	}
});
