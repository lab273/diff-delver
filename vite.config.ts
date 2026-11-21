import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { CORE_TEST_DIRECTORY, TIME_LIMITS } from './scripts/test-time-limits.ts';

// Tests are held to time guidance, which `pnpm verify` reports as warnings. The
// timeouts here are only the hang timeouts, far above the guidance, so that a test
// that hangs fails instead of blocking the run (scripts/test-time-limits.ts).

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// A prefix of its own, so the reviewer's PORT, ORIGIN or BODY_SIZE_LIMIT never reach it.
			adapter: adapter({ envPrefix: 'DIFF_DELVER_APP_' }),
			// The pages need nothing from anywhere but the daemon, and run only its own
			// scripts: SvelteKit adds a nonce for the ones it writes into a page. Styles
			// may be inline, as SvelteKit's own and the bundled fonts' small faces are.
			csp: {
				mode: 'nonce',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self', 'data:'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['none'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		// A committed `.only` would silently skip the other tests, here as in CI.
		allowOnly: false,
		passWithNoTests: true,
		projects: [
			{
				// Pure domain code. Needs no SvelteKit, so the project does not load the
				// SvelteKit plugin and starts quickly.
				extends: false,
				test: {
					name: 'core',
					environment: 'node',
					include: [`${CORE_TEST_DIRECTORY}**/*.test.ts`],
					testTimeout: TIME_LIMITS.core.hangTimeout,
					hookTimeout: TIME_LIMITS.core.hangTimeout,
					allowOnly: false,
					expect: { requireAssertions: true }
				}
			},
			{
				// Everything else under src: sources, the store, the MCP tools, the daemon;
				// and the replay of the agent trials' recordings.
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/agent-trials/**/*.test.ts'],
					exclude: [`${CORE_TEST_DIRECTORY}**`],
					globalSetup: ['tests/support/vitest-global-setup.ts'],
					// The production build, which the daemon tests serve, runs as Node runs it,
					// not through Vite's transform, as the command does.
					server: { deps: { external: [/\/build\//] } },
					testTimeout: TIME_LIMITS.integration.hangTimeout,
					hookTimeout: TIME_LIMITS.integration.hangTimeout,
					allowOnly: false
				}
			}
		]
	}
});
