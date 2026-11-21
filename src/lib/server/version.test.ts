import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeVersion } from './version.ts';

describe('codeVersion', () => {
	it('is the package version, marked as no release, from source, when run unbuilt', async () => {
		const packageJson: unknown = JSON.parse(
			await readFile(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')
		);
		const version =
			typeof packageJson === 'object' && packageJson !== null && 'version' in packageJson
				? packageJson.version
				: undefined;
		expect(typeof version).toBe('string');
		expect(codeVersion()).toBe(`${String(version)}-dev+source`);
	});
});
