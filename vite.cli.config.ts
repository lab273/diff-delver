/**
 * The build of the `diff-delver` command (`build/cli/diff-delver.js`), made
 * after the app's (`vite build`, which empties `build/` first). Everything the
 * command runs is bundled, so it needs no TypeScript at run time: Node does not
 * strip types from files under node_modules, which is where `npx` or `pnpm
 * dlx` put it. The app it serves stays in `build/handler.js`, loaded when a
 * daemon starts, and is left out of this bundle (`#build/handler.js`).
 *
 * The version it reports is the package version and a hash of everything the
 * build is made from, so two builds of the same code have the same version and
 * a command can tell whether a running daemon is its own.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

function codeHash(): string {
	const hash = createHash('sha256');
	const inputs = [
		...filesUnder(join(root, 'src')).filter((path) => !path.endsWith('.test.ts')),
		join(root, 'package.json'),
		join(root, 'pnpm-lock.yaml'),
		join(root, 'vite.config.ts'),
		join(root, 'vite.cli.config.ts')
	].toSorted();
	for (const path of inputs) {
		hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
	}
	return hash.digest('hex').slice(0, 12);
}

const packageJson: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageVersion =
	typeof packageJson === 'object' &&
	packageJson !== null &&
	'version' in packageJson &&
	typeof packageJson.version === 'string'
		? packageJson.version
		: '0.0.0';

export default defineConfig({
	define: {
		__DIFF_DELVER_VERSION__: JSON.stringify(`${packageVersion}+${codeHash()}`)
	},
	build: {
		ssr: 'src/lib/server/cli/run.ts',
		outDir: 'build/cli',
		emptyOutDir: true,
		target: 'node26',
		minify: false,
		sourcemap: true,
		rolldownOptions: {
			external: ['#build/handler.js'],
			output: { entryFileNames: 'diff-delver.js', format: 'es' }
		}
	},
	ssr: { noExternal: true, target: 'node' }
});
