/**
 * The build of the `diff-delver` command (`build/cli/diff-delver.js`), made
 * after the app's (`vite build`, which empties `build/` first). Everything the
 * command runs is bundled, so it needs no TypeScript at run time: Node does not
 * strip types from files under node_modules, which is where `npx` or `pnpm
 * dlx` put it. The app it serves stays in `build/handler.js`, loaded when a
 * daemon starts, and is left out of this bundle (`#build/handler.js`).
 *
 * The version it reports is a release and a hash of everything the build is
 * made from, so two builds of the same code have the same version and a command
 * can tell whether a running daemon is its own. The release workflow gives the
 * release in `DIFF_DELVER_RELEASE_VERSION` (docs/DEVELOPING.md, "Releasing"), which is how
 * it is stamped in without anything being committed; any other build, such as a
 * clone's, reports the package version marked `-dev`, which is no release.
 *
 * It also records the commit it was built from, when it was made and whether
 * the working tree had changes not committed to what the hash is made of, for the header of every page
 * (`core/build-identity.ts`); nothing, when git or the repository is not there,
 * as for a build of a downloaded copy.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig } from 'vite';
import { parseReleaseVersion } from './src/lib/core/release-version.tiny.ts';

const root = import.meta.dirname;

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

/** What the version's hash is made of, besides `src` without its tests; and what "+ changes" looks at. */
const CODE_FILES = ['package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'vite.cli.config.ts'];

function isCodeInput(path: string): boolean {
	return !path.endsWith('.test.ts');
}

function codeHash(): string {
	const hash = createHash('sha256');
	const inputs = [
		...filesUnder(join(root, 'src')).filter(isCodeInput),
		...CODE_FILES.map((name) => join(root, name))
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

function releaseVersion(): string {
	const given = process.env['DIFF_DELVER_RELEASE_VERSION'];
	if (given === undefined || given === '') return `${packageVersion}-dev`;
	const parsed = parseReleaseVersion(given);
	if (!parsed.ok) {
		throw new Error(
			`DIFF_DELVER_RELEASE_VERSION is "${given}", which is not a release version. Give three whole numbers, such as 0.2.0, or leave it unset for a build that is no release.`
		);
	}
	return parsed.value;
}

/** What git says in this folder, or undefined when it says nothing or is not there. */
function git(...args: string[]): string | undefined {
	try {
		// Never taking git's index lock, so a build beside a person's own git changes nothing.
		return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
	} catch {
		return undefined;
	}
}

/** The commit this is built from, when this folder is the top of a git repository. */
function buildCommit(): { commit: string; committedAt: number | null; changes: boolean } | null {
	const top = git('rev-parse', '--show-toplevel')?.trim();
	if (top === undefined || realpathSync(top) !== realpathSync(root)) return null;
	const commit = git('rev-parse', '--verify', 'HEAD')?.trim();
	if (commit === undefined || commit === '') return null;
	const committedAt = Date.parse(git('log', '-1', '--format=%cI', 'HEAD')?.trim() ?? '');
	// Changes only to what the version's hash is made of: an edited README or a stray file is not one.
	const status = git('status', '--porcelain', '--untracked-files=all', '--', 'src', ...CODE_FILES);
	const changed = (status ?? '')
		.split('\n')
		.map((line) => line.slice(3))
		.filter((path) => path !== '' && isCodeInput(path));
	return {
		commit,
		committedAt: Number.isNaN(committedAt) ? null : committedAt,
		changes: changed.length > 0
	};
}

export default defineConfig({
	define: {
		__DIFF_DELVER_VERSION__: JSON.stringify(`${releaseVersion()}+${codeHash()}`),
		__DIFF_DELVER_COMMIT__: JSON.stringify(buildCommit())
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
