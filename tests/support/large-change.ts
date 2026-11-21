/**
 * A repository at the size the design promises, for the tests that measure at
 * full scale: 2,000 files and 200,000 changed lines between the tag `base` and
 * HEAD, and a branch `next` for an update.
 */
import { defineFixture } from './fixture-repos.ts';

export const FILES = 2_000;

/**
 * 2,000 files of 100 lines, tagged `base`; the next commit rewrites the first 50
 * lines of each. Branch `next` adds a line at the top of every file on top of
 * that, for an update; HEAD stays at the commit before it.
 */
export const largeChange = defineFixture('large-change', async (repo) => {
	const lines = (prefix: string, from: number, to: number): string =>
		Array.from({ length: to - from + 1 }, (_, i) => `${prefix} line ${String(from + i)}\n`).join(
			''
		);
	const name = (i: number): string =>
		`src/module-${String(Math.floor(i / 100)).padStart(2, '0')}/file-${String(i).padStart(4, '0')}.ts`;
	for (let i = 0; i < FILES; i += 1) await repo.write(name(i), lines('old', 1, 100));
	await repo.commit('base', 'base');
	for (let i = 0; i < FILES; i += 1) {
		await repo.write(name(i), lines('new', 1, 50) + lines('old', 51, 100));
	}
	await repo.commit('head');
	for (let i = 0; i < FILES; i += 1) {
		await repo.write(name(i), `top\n${lines('new', 1, 50)}${lines('old', 51, 100)}`);
	}
	await repo.commit('next');
	await repo.git('branch', 'next');
	await repo.git('reset', '--quiet', '--soft', 'HEAD~1');
});
