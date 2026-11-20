/**
 * The production build, for the integration tests that run the real command
 * and its daemon (`build/cli/diff-delver.js` and `build/handler.js`). It is made
 * again only when something it is built from is newer than it: `pnpm verify`
 * builds before the tests, so there it is never made twice.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/** What the build is made from. */
const INPUTS = [
	'src',
	'static',
	'package.json',
	'pnpm-lock.yaml',
	'vite.config.ts',
	'vite.cli.config.ts'
];

/** The files the tests need from the build. */
export const BUILT_COMMAND = join(ROOT, 'bin', 'diff-delver.js');
const OUTPUTS = [join(ROOT, 'build', 'cli', 'diff-delver.js'), join(ROOT, 'build', 'handler.js')];

function newest(path: string): number {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return 0;
	if (!stat.isDirectory()) return path.endsWith('.test.ts') ? 0 : stat.mtimeMs;
	return Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newest(join(path, name))));
}

function oldest(paths: readonly string[]): number {
	return Math.min(...paths.map((path) => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0));
}

export function ensureBuild(): void {
	const sources = Math.max(...INPUTS.map((input) => newest(join(ROOT, input))));
	if (oldest(OUTPUTS) > sources) return;
	console.log('Building diff delver for the tests that run it (pnpm build)…');
	const bin = (name: string): string => join(ROOT, 'node_modules', '.bin', name);
	for (const args of [
		['build', '--logLevel', 'warn'],
		['build', '--config', 'vite.cli.config.ts', '--logLevel', 'warn']
	]) {
		const built = spawnSync(bin('vite'), args, { cwd: ROOT, stdio: 'inherit' });
		if (built.status !== 0) throw new Error('The build failed; see above.');
	}
}
