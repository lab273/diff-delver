/**
 * Packs the built diff delver into the tarball a release attaches
 * (`pnpm release:package`, README "Releasing"):
 *
 *   node scripts/release-package.ts [--version <release>] [--out <folder>]
 *
 * It uses the build already in `build/`, as `pnpm build` or `pnpm verify` made
 * it, and never builds itself, so what is packed is what was tested. With
 * `--version`, the build must report that release (it does when it was made
 * with `DIFF_DELVER_RELEASE_VERSION` set to it); without, the package takes
 * whatever version the build reports, such as `0.0.1-dev`, which is how the
 * tests pack it.
 *
 * The folder (`release/` by default, ignored by git) gets:
 *   diff-delver.tgz         the package: bin, the build without its source maps,
 *                           LICENSE, README.md and a package.json for it
 *   diff-delver.tgz.sha256  its checksum, as `sha256sum -c` reads it
 *   release-notes.md        what the release's page says
 *
 * The package.json is the repository's, cut down to what running needs: no
 * scripts (so installing it runs nothing), no development dependencies, and
 * still `"private": true`. It must list no dependencies, since the build bundles
 * everything; a package that needed a registry would not be the tested one.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseAbsolutePath, type AbsolutePath } from '../src/lib/core/absolute-path.tiny.ts';
import { parseByteSize, type ByteSize } from '../src/lib/core/byte-size.tiny.ts';
import { parseCodeVersion, type CodeVersion } from '../src/lib/core/code-version.tiny.ts';
import {
	parseReleaseVersion,
	releaseOfCodeVersion,
	releaseTag,
	type ReleaseVersion
} from '../src/lib/core/release-version.tiny.ts';
import { err, ok, type Result } from '../src/lib/core/result.ts';

const run = promisify(execFile);

/** The repository on GitHub, whose releases hold the package. */
export const REPOSITORY = 'lab273/diff-delver';

/** The tarball's name in every release, so the latest one has a fixed address. */
export const TARBALL_NAME = 'diff-delver.tgz';
export const CHECKSUM_NAME = `${TARBALL_NAME}.sha256`;
export const NOTES_NAME = 'release-notes.md';

/** Where the newest release's tarball always is. */
export const LATEST_TARBALL_URL = `https://github.com/${REPOSITORY}/releases/latest/download/${TARBALL_NAME}`;

/** The command a newcomer runs. */
export const RUN_COMMAND = `npx ${LATEST_TARBALL_URL}`;

/** What the package holds, besides package.json: the build is copied without its source maps. */
const CONTENTS = ['bin', 'build', 'LICENSE', 'README.md'] as const;

/** The build's files the command needs; their absence means there is no build. */
const BUILT = [join('build', 'cli', 'diff-delver.js'), join('build', 'handler.js')];

export type PackageError =
	| { readonly kind: 'NoBuild'; readonly missing: string }
	| { readonly kind: 'BuildDoesNotRun'; readonly detail: string }
	| {
			readonly kind: 'WrongBuildVersion';
			readonly wanted: ReleaseVersion;
			readonly built: CodeVersion;
	  }
	| { readonly kind: 'UnreadablePackageJson'; readonly detail: string }
	| { readonly kind: 'HasDependencies'; readonly names: readonly string[] }
	| { readonly kind: 'PackFailed'; readonly detail: string };

/** What happened and what to do next, for the person packaging. */
export function describePackageError(error: PackageError): string {
	switch (error.kind) {
		case 'NoBuild':
			return `There is no build to pack: ${error.missing} is missing. Run pnpm build (for a release, with DIFF_DELVER_RELEASE_VERSION set to its version), then try again.`;
		case 'BuildDoesNotRun':
			return `The build in build/ did not say its version when asked (${error.detail}). Run pnpm build again, then try again.`;
		case 'WrongBuildVersion':
			return `The build in build/ is version ${error.built}, not release ${error.wanted}. Build it for this release with DIFF_DELVER_RELEASE_VERSION=${error.wanted} pnpm build, then try again.`;
		case 'UnreadablePackageJson':
			return `package.json could not be read (${error.detail}). Fix it, then try again.`;
		case 'HasDependencies':
			return `package.json lists dependencies (${error.names.join(', ')}), but the released package must need nothing from a registry. Move them to devDependencies, so the build bundles them, then build and try again.`;
		case 'PackFailed':
			return `npm could not pack the package (${error.detail}). Check that npm, which comes with Node, works, then try again.`;
	}
}

/** The repository's package.json, cut down to what the released package needs. */
export function releasePackageJson(
	source: unknown,
	version: string
): Result<Record<string, unknown>, PackageError> {
	if (typeof source !== 'object' || source === null || Array.isArray(source)) {
		return err({ kind: 'UnreadablePackageJson', detail: 'it is not a JSON object' });
	}
	const fields = new Map<string, unknown>(Object.entries(source));
	const dependencies = fields.get('dependencies');
	if (typeof dependencies === 'object' && dependencies !== null) {
		const names = Object.keys(dependencies);
		if (names.length > 0) return err({ kind: 'HasDependencies', names });
	}
	const kept: Record<string, unknown> = {};
	for (const name of ['name', 'description', 'license', 'type', 'bin', 'engines']) {
		const value = fields.get(name);
		if (value === undefined) {
			return err({ kind: 'UnreadablePackageJson', detail: `it has no "${name}"` });
		}
		kept[name] = value;
	}
	return ok({
		name: kept['name'],
		version,
		description: kept['description'],
		license: kept['license'],
		private: true,
		repository: `github:${REPOSITORY}`,
		type: kept['type'],
		bin: kept['bin'],
		files: [...CONTENTS],
		engines: kept['engines'],
		// The command loads the app from the build by this name (src/build-handler.d.ts).
		imports: { '#build/handler.js': './build/handler.js' }
	});
}

/** What a release's page says. */
export function releaseNotes(version: ReleaseVersion | undefined): string {
	const pinned =
		version === undefined
			? undefined
			: `https://github.com/${REPOSITORY}/releases/download/${releaseTag(version)}/${TARBALL_NAME}`;
	return [
		`diff delver${version === undefined ? '' : ` ${version}`}: review a diff in your browser.`,
		'',
		'With Node 26 (or newer) and git, run this in a git repository with changes:',
		'',
		'```',
		RUN_COMMAND,
		'```',
		'',
		'That address always gives the newest release. npx asks once whether to install it, and then keeps the copy it installed first; to move to a newer release, see "Upgrading" in the README.',
		...(pinned === undefined
			? []
			: ['', 'To run exactly this release:', '', '```', `npx ${pinned}`, '```']),
		'',
		`To check the download, compare it with ${CHECKSUM_NAME}: \`sha256sum -c ${CHECKSUM_NAME}\` in the folder holding both.`,
		'',
		'diff delver is not published to npm. This release ran every test (`pnpm verify`) on its commit before it was packed, and the packed package was installed and run before it was released.',
		''
	].join('\n');
}

export interface Packaged {
	readonly tarball: AbsolutePath;
	readonly size: ByteSize;
	readonly sha256: string;
	readonly version: CodeVersion;
}

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(resolve(path));
	if (!parsed.ok) throw new Error(`Not a path: ${path}`);
	return parsed.value;
}

function detailOf(error: unknown): string {
	const stderr =
		typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
	const message = error instanceof Error ? error.message : String(error);
	return (stderr.trim() || message).split('\n').slice(-3).join(' ');
}

/** The version the build in `root` reports, by running it. */
export async function builtVersion(root: AbsolutePath): Promise<Result<CodeVersion, PackageError>> {
	for (const path of BUILT) {
		if ((await stat(join(root, path)).catch(() => undefined)) === undefined) {
			return err({ kind: 'NoBuild', missing: path });
		}
	}
	try {
		const { stdout } = await run(process.execPath, [
			join(root, 'bin', 'diff-delver.js'),
			'--version'
		]);
		const parsed = parseCodeVersion(stdout.trim().replace(/^diff-delver /, ''));
		if (!parsed.ok)
			return err({ kind: 'BuildDoesNotRun', detail: `it printed "${stdout.trim()}"` });
		return ok(parsed.value);
	} catch (error) {
		return err({ kind: 'BuildDoesNotRun', detail: detailOf(error) });
	}
}

/** An environment for npm that asks nothing of the network and changes nothing of the machine's. */
function npmEnvironment(cache: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		npm_config_cache: cache,
		npm_config_update_notifier: 'false',
		npm_config_audit: 'false',
		npm_config_fund: 'false'
	};
}

export async function packageRelease(options: {
	readonly root: AbsolutePath;
	readonly out: AbsolutePath;
	readonly version: ReleaseVersion | undefined;
}): Promise<Result<Packaged, PackageError>> {
	const { root, out } = options;
	const built = await builtVersion(root);
	if (!built.ok) return built;
	const release = releaseOfCodeVersion(built.value);
	if (options.version !== undefined && release !== options.version) {
		return err({ kind: 'WrongBuildVersion', wanted: options.version, built: built.value });
	}
	const packageVersion = built.value.split('+')[0] ?? built.value;
	let source: unknown;
	try {
		source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	} catch (error) {
		return err({ kind: 'UnreadablePackageJson', detail: detailOf(error) });
	}
	const manifest = releasePackageJson(source, packageVersion);
	if (!manifest.ok) return manifest;

	const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-package-'));
	try {
		const stage = join(scratch, 'package');
		await mkdir(stage);
		for (const name of CONTENTS) {
			await cp(join(root, name), join(stage, name), {
				recursive: true,
				filter: (path) => !path.endsWith('.map')
			});
		}
		await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest.value, null, '\t')}\n`);
		await mkdir(out, { recursive: true });
		let packed: string;
		try {
			const { stdout } = await run(
				'npm',
				['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
				{ cwd: stage, env: npmEnvironment(join(scratch, 'npm-cache')) }
			);
			const listed: unknown = JSON.parse(stdout);
			const first: unknown = Array.isArray(listed) ? listed[0] : undefined;
			const filename =
				typeof first === 'object' && first !== null && 'filename' in first
					? first.filename
					: undefined;
			if (typeof filename !== 'string') {
				return err({ kind: 'PackFailed', detail: 'it did not say which file it wrote' });
			}
			packed = join(scratch, basename(filename));
		} catch (error) {
			return err({ kind: 'PackFailed', detail: detailOf(error) });
		}
		const tarball = join(out, TARBALL_NAME);
		await rename(packed, tarball).catch(async () => {
			await cp(packed, tarball);
		});
		const bytes = await readFile(tarball);
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		await writeFile(join(out, CHECKSUM_NAME), `${sha256}  ${TARBALL_NAME}\n`);
		await writeFile(join(out, NOTES_NAME), releaseNotes(release));
		const size = parseByteSize(bytes.length);
		if (!size.ok) throw new Error('A file has no size.');
		return ok({ tarball: absolute(tarball), size: size.value, sha256, version: built.value });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function usage(problem: string): never {
	process.stderr.write(
		`${problem}\nUsage: node scripts/release-package.ts [--version <release, such as 0.2.0>] [--out <folder>]\n`
	);
	process.exit(2);
}

async function main(args: readonly string[]): Promise<number> {
	let version: ReleaseVersion | undefined;
	let out = 'release';
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === '--version' && next !== undefined) {
			const parsed = parseReleaseVersion(next);
			if (!parsed.ok) {
				usage(`"${next}" is not a release version. Give three whole numbers, such as 0.2.0.`);
			}
			version = parsed.value;
			i += 1;
		} else if (arg === '--out' && next !== undefined) {
			out = next;
			i += 1;
		} else {
			usage(`"${arg ?? ''}" is not something this script takes.`);
		}
	}
	const root = absolute(join(import.meta.dirname, '..'));
	const packaged = await packageRelease({ root, out: absolute(out), version });
	if (!packaged.ok) {
		process.stderr.write(`${describePackageError(packaged.error)}\n`);
		return 1;
	}
	const { tarball, size, sha256 } = packaged.value;
	process.stdout.write(
		`Packed diff delver ${packaged.value.version} into ${tarball} (${String(Math.round(size / 1024))} KiB, sha256 ${sha256}).\nCheck it works with: pnpm release:check ${tarball}\n`
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
