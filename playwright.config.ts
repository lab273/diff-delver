import { createServer } from 'node:net';
import { defineConfig, devices } from '@playwright/test';
import { TIME_LIMITS } from './scripts/test-time-limits.ts';

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
// that hangs fails instead of blocking the run (scripts/test-time-limits.ts).
const HANG_TIMEOUT_MS = TIME_LIMITS.journey.hangTimeout;

// How long one `expect` keeps polling for its condition, such as an element
// becoming visible. Playwright's default of 5 seconds is a timing limit a slow,
// busy machine can reach with nothing wrong, so it is raised to a hang timeout too.
const EXPECT_HANG_TIMEOUT_MS = 60_000;

export default defineConfig({
	testDir: 'tests/journeys',
	testMatch: '**/*.journey.ts',
	timeout: HANG_TIMEOUT_MS,
	expect: { timeout: EXPECT_HANG_TIMEOUT_MS },
	fullyParallel: true,
	// A committed `.only` would silently skip every other journey, here as in CI.
	forbidOnly: true,
	retries: 0,
	reporter: process.env['CI'] !== undefined ? [['list'], ['github']] : 'list',
	use: {
		baseURL,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'node build',
		url: baseURL,
		reuseExistingServer: false,
		stdout: 'ignore',
		stderr: 'pipe',
		env: { HOST: '127.0.0.1', PORT: port, ORIGIN: baseURL }
	}
});
