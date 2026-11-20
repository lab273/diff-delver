import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

// Per-test budgets from the README, "Testing". A test over its budget fails.
const CORE_TEST_BUDGET_MS = 250;
const INTEGRATION_TEST_BUDGET_MS = 3_000;

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	test: {
		expect: { requireAssertions: true },
		passWithNoTests: true,
		projects: [
			{
				// Pure domain code. Needs no SvelteKit, so the project does not load the
				// SvelteKit plugin and starts quickly.
				extends: false,
				test: {
					name: 'core',
					environment: 'node',
					include: ['src/lib/core/**/*.test.ts'],
					testTimeout: CORE_TEST_BUDGET_MS,
					hookTimeout: CORE_TEST_BUDGET_MS,
					expect: { requireAssertions: true }
				}
			},
			{
				// Everything else under src: sources, the store, the MCP tools, the daemon.
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['src/lib/core/**'],
					testTimeout: INTEGRATION_TEST_BUDGET_MS,
					hookTimeout: INTEGRATION_TEST_BUDGET_MS
				}
			}
		]
	}
});
