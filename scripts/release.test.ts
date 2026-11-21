/**
 * The released package, without releasing: packs the build `pnpm verify` made,
 * as the release workflow does, and runs the same check the workflow runs before
 * it releases (install with npx from a local address, with only Node and git,
 * open a diff, stop), offline. A change that breaks the released package fails
 * here, long before anyone starts a release.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../src/lib/core/absolute-path.tiny.ts';
import { parseReleaseVersion, type ReleaseVersion } from '../src/lib/core/release-version.tiny.ts';
import { ensureBuild } from '../tests/support/build.ts';
import { tempDirectory } from '../tests/support/fixture-repos.ts';
import { checkPackage, describeCheckError, unexpectedEntries } from './release-check.ts';
import {
	CHECKSUM_NAME,
	describePackageError,
	LATEST_TARBALL_URL,
	NOTES_NAME,
	packageRelease,
	releaseNotes,
	releasePackageJson,
	RUN_COMMAND
} from './release-package.ts';

const ROOT = absolute(join(import.meta.dirname, '..'));

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(path);
	return parsed.value;
}

function release(text: string): ReleaseVersion {
	const parsed = parseReleaseVersion(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

describe('the released package', () => {
	it('packs from the build, installs with npx from an address with only Node and git, opens a diff and stops, offline', async () => {
		ensureBuild();
		const out = await tempDirectory();
		const packaged = await packageRelease({ root: ROOT, out, version: undefined });
		if (!packaged.ok) throw new Error(describePackageError(packaged.error));
		expect(packaged.value.version).toMatch(/^0\.0\.1-dev\+[0-9a-f]{12}$/);

		const bytes = await readFile(packaged.value.tarball);
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		expect(packaged.value.sha256).toBe(sha256);
		expect(await readFile(join(out, CHECKSUM_NAME), 'utf8')).toBe(`${sha256}  diff-delver.tgz\n`);
		expect(await readFile(join(out, NOTES_NAME), 'utf8')).toContain(RUN_COMMAND);

		const checked = await checkPackage({ tarball: packaged.value.tarball, version: undefined });
		if (!checked.ok) throw new Error(describeCheckError(checked.error));
		expect(checked.value.version).toBe(packaged.value.version);
		expect(checked.value.downloaded).toBeGreaterThanOrEqual(bytes.length);
	});

	it('refuses a build of another version than the release asked for', async () => {
		const packaged = await packageRelease({
			root: ROOT,
			out: await tempDirectory(),
			version: release('9.9.9')
		});
		expect(packaged.ok).toBe(false);
		if (packaged.ok) return;
		expect(packaged.error.kind).toBe('WrongBuildVersion');
		expect(describePackageError(packaged.error)).toContain(
			'DIFF_DELVER_RELEASE_VERSION=9.9.9 pnpm build'
		);
	});

	it('refuses to pack when there is no build', async () => {
		const empty = await tempDirectory();
		const packaged = await packageRelease({ root: empty, out: empty, version: undefined });
		expect(packaged.ok).toBe(false);
		if (!packaged.ok) expect(packaged.error.kind).toBe('NoBuild');
	});

	it('refuses to check what is not a package of diff delver', async () => {
		const folder = await tempDirectory();
		const missing = await checkPackage({
			tarball: absolute(join(folder, 'none.tgz')),
			version: undefined
		});
		expect(missing.ok ? undefined : missing.error.kind).toBe('NoTarball');
		const junk = absolute(join(folder, 'junk.tgz'));
		await writeFile(junk, 'not a tarball');
		const unreadable = await checkPackage({ tarball: junk, version: undefined });
		expect(unreadable.ok ? undefined : unreadable.error.kind).toBe('StepFailed');
	});
});

describe('the released package.json', () => {
	const source = {
		name: 'diff-delver',
		version: '0.0.1',
		description: 'd',
		license: 'AGPL-3.0-only',
		private: true,
		type: 'module',
		bin: { 'diff-delver': 'bin/diff-delver.js' },
		engines: { node: '>=26' },
		scripts: { prepare: 'vite build' },
		devDependencies: { vite: '^8' },
		packageManager: 'pnpm@12'
	};

	it('keeps what running needs, stays private, and has no scripts or development dependencies', () => {
		const made = releasePackageJson(source, '0.2.0');
		expect(made).toEqual({
			ok: true,
			value: {
				name: 'diff-delver',
				version: '0.2.0',
				description: 'd',
				license: 'AGPL-3.0-only',
				private: true,
				repository: 'github:lab273/diff-delver',
				type: 'module',
				bin: { 'diff-delver': 'bin/diff-delver.js' },
				files: ['bin', 'build', 'LICENSE', 'README.md'],
				engines: { node: '>=26' },
				imports: { '#build/handler.js': './build/handler.js' }
			}
		});
	});

	it('refuses dependencies, which a registry would have to supply', () => {
		const made = releasePackageJson({ ...source, dependencies: { zod: '^4' } }, '0.2.0');
		expect(made.ok).toBe(false);
		if (made.ok) return;
		expect(made.error).toEqual({ kind: 'HasDependencies', names: ['zod'] });
		expect(describePackageError(made.error)).toContain('Move them to devDependencies');
	});

	it('is the repository package.json, which lists no dependencies', async () => {
		const real: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
		expect(releasePackageJson(real, '0.2.0').ok).toBe(true);
	});
});

describe('what a released tarball may hold', () => {
	it('is package.json, the licence, the README, bin and the build, without source maps', () => {
		expect(
			unexpectedEntries([
				'package/package.json',
				'package/LICENSE',
				'package/README.md',
				'package/bin/diff-delver.js',
				'package/build/handler.js',
				'package/build/client/_app/immutable/a.js',
				'package/build/cli/diff-delver.js.map',
				'package/src/lib/core/result.ts',
				'package/tests/journeys/screenshots/a.png',
				'package/.beads/config.yaml',
				'package/build/node_modules/zod/index.js',
				'package/pnpm-lock.yaml'
			])
		).toEqual([
			'package/build/cli/diff-delver.js.map',
			'package/src/lib/core/result.ts',
			'package/tests/journeys/screenshots/a.png',
			'package/.beads/config.yaml',
			'package/build/node_modules/zod/index.js',
			'package/pnpm-lock.yaml'
		]);
	});
});

describe('release notes', () => {
	it('say how to run the newest release and exactly this one, and how to check the download', () => {
		const notes = releaseNotes(release('0.2.0'));
		expect(notes).toContain(`npx ${LATEST_TARBALL_URL}`);
		expect(notes).toContain(
			'npx https://github.com/lab273/diff-delver/releases/download/v0.2.0/diff-delver.tgz'
		);
		expect(notes).toContain('sha256sum -c diff-delver.tgz.sha256');
		expect(notes).toContain('not published to npm');
	});
});
