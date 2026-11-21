/**
 * The build the integration tests run is a production one: its app finds the
 * daemon a test started, with the test's own data folder, and never makes
 * `pnpm dev`'s daemon on the machine's data folder.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEnvironment } from '../../../../tests/support/build.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('the build the tests run', () => {
	it('is made for production even though the tests run with NODE_ENV set to test', () => {
		expect(process.env.NODE_ENV).toBe('test');
		expect(buildEnvironment().NODE_ENV).toBe('production');
	});

	it('carries no daemon of its own for the machine’s data folder', async () => {
		const hooks = await readFile(
			join(ROOT, 'build', 'server', 'entries', 'hooks.server.js'),
			'utf8'
		);
		expect(hooks).not.toContain('development');
	});
});
