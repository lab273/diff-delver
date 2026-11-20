import { createServer } from 'node:net';
import { defineConfig, devices } from '@playwright/test';

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

// Per-test budget from the README, "Testing". A journey over its budget fails.
const JOURNEY_BUDGET_MS = 20_000;

export default defineConfig({
	testDir: 'tests/journeys',
	testMatch: '**/*.journey.ts',
	timeout: JOURNEY_BUDGET_MS,
	fullyParallel: true,
	forbidOnly: process.env['CI'] !== undefined,
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
