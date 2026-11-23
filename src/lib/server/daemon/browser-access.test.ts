import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath } from '../../../../tests/support/git-repo.ts';
import { BROWSER_ACCESS_FILE, browserAccess } from './browser-access.ts';

describe('browser access kept in the data folder', () => {
	it('is made once, for its owner alone, and found again', async () => {
		const data = await tempDirectory();
		const made = await browserAccess(data);
		expect(made.notKept).toBeUndefined();
		expect(made.id).toMatch(/^[0-9a-f]{16}$/);
		expect(made.token).toMatch(/^[0-9a-f]{64}$/);
		const file = join(data, BROWSER_ACCESS_FILE);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ id: made.id, token: made.token });
		expect(await browserAccess(data)).toEqual(made);
		// Nothing half-written is left beside it.
		expect(await readdir(data)).toEqual([BROWSER_ACCESS_FILE]);
		// Another folder has its own.
		const other = await browserAccess(await tempDirectory());
		expect(other.id).not.toBe(made.id);
		expect(other.token).not.toBe(made.token);
	});

	it('replaces a file that is not one, or that others may read', async () => {
		const data = await tempDirectory();
		const file = join(data, BROWSER_ACCESS_FILE);
		const first = await browserAccess(data);
		for (const text of [
			'',
			'not json',
			'{"id":"x","token":"y"}',
			JSON.stringify({ id: first.id, token: first.token, more: 1 }),
			JSON.stringify({ token: first.token })
		]) {
			await writeFile(file, text, { mode: 0o600 });
			const next = await browserAccess(data);
			expect(next.notKept).toBeUndefined();
			expect(next.token).not.toBe(first.token);
			expect(await browserAccess(data)).toEqual(next);
		}
		// A copy that anyone on the machine could have read is no longer a secret.
		const kept = await browserAccess(data);
		await chmod(file, 0o644);
		const replaced = await browserAccess(data);
		expect(replaced.token).not.toBe(kept.token);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it('still gives access, for this daemon only, when the folder cannot be written', async () => {
		const parent = await tempDirectory();
		const data = absolutePath(join(parent, 'data'));
		await mkdir(data, { mode: 0o500 });
		try {
			const first = await browserAccess(data);
			expect(first.notKept).toBeDefined();
			expect(first.token).toMatch(/^[0-9a-f]{64}$/);
			expect((await browserAccess(data)).token).not.toBe(first.token);
			expect(await readdir(data)).toEqual([]);
		} finally {
			await chmod(data, 0o700);
		}
	});
});
