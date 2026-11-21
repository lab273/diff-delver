/**
 * Proves a packed diff delver works before it is released (`pnpm
 * release:check`, README "Releasing"):
 *
 *   node scripts/release-check.ts <tarball> [--version <release>]
 *
 * In a fresh temporary folder, with a home folder, npm cache and data folder of
 * its own and only node, npm, npx, git and sh on the path (none of this
 * repository, its node_modules or the machine's settings), it serves the
 * tarball over HTTP on 127.0.0.1 the way GitHub serves a release's asset (the
 * latest address redirecting to the file), and runs the newcomer's command,
 * `npx --yes <address>`, as a person would:
 *
 *   1. checks the tarball holds only what running needs;
 *   2. `--version`, which must print the release given, if one is;
 *   3. in a new git repository with a change, `--no-open` with a temporary data
 *      folder, and asks the address it prints for the page, which must answer;
 *   4. `stop`, which must stop the daemon it started.
 *
 * npm's registry is pointed at the same local server, which answers nothing but
 * the tarball, so a package that needed anything from a registry fails here,
 * and the check works offline. It says how long the first run took and how much
 * it downloaded.
 */
import { execFile, type ExecException } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '../src/lib/core/absolute-path.tiny.ts';
import { parseByteSize, type ByteSize } from '../src/lib/core/byte-size.tiny.ts';
import { parseCodeVersion, type CodeVersion } from '../src/lib/core/code-version.tiny.ts';
import { millisecondsOf, type Milliseconds } from '../src/lib/core/milliseconds.tiny.ts';
import {
	parseReleaseVersion,
	releaseOfCodeVersion,
	type ReleaseVersion
} from '../src/lib/core/release-version.tiny.ts';
import { err, ok, type Result } from '../src/lib/core/result.ts';
import { TARBALL_NAME } from './release-package.ts';

/** Paths in the tarball, under npm's `package/`, that a released package may hold. */
const ALLOWED = [
	/^package\/package\.json$/,
	/^package\/LICENSE$/,
	/^package\/README\.md$/,
	/^package\/bin\/[^/]+\.js$/,
	/^package\/build\/.+$/
];

/** What may not be in the build either. */
const FORBIDDEN = [/\.map$/, /\.test\.ts$/, /(^|\/)node_modules\//, /(^|\/)\.beads\//];

/** The entries of a tarball that a released package must not hold. */
export function unexpectedEntries(entries: readonly string[]): readonly string[] {
	return entries.filter(
		(entry) =>
			!entry.endsWith('/') &&
			(!ALLOWED.some((rule) => rule.test(entry)) || FORBIDDEN.some((rule) => rule.test(entry)))
	);
}

const NEEDED_ENTRIES = [
	'package/package.json',
	'package/LICENSE',
	'package/README.md',
	'package/bin/diff-delver.js',
	'package/build/cli/diff-delver.js',
	'package/build/handler.js'
];

/** How long any one step may take before the check gives up on it. */
const STEP_TIMEOUT_MS = 120_000;

export type CheckError =
	| { readonly kind: 'NoTarball'; readonly path: string }
	| { readonly kind: 'ToolMissing'; readonly tool: string }
	| {
			readonly kind: 'WrongContents';
			readonly unexpected: readonly string[];
			readonly missing: readonly string[];
	  }
	| { readonly kind: 'StepFailed'; readonly step: string; readonly detail: string }
	| { readonly kind: 'WrongVersion'; readonly wanted: ReleaseVersion; readonly printed: string }
	| { readonly kind: 'PageDidNotAnswer'; readonly detail: string }
	| { readonly kind: 'RegistryAsked'; readonly paths: readonly string[] };

/** What went wrong and what to do next, for the person releasing. */
export function describeCheckError(error: CheckError): string {
	const nothing = 'Nothing should be released from this package.';
	switch (error.kind) {
		case 'NoTarball':
			return `There is no tarball at ${error.path}. Pack one with pnpm release:package, then check it.`;
		case 'ToolMissing':
			return `The check needs ${error.tool} on the path, as a newcomer has it, and it could not be found. Install it, then try again.`;
		case 'WrongContents':
			return `The package does not hold exactly what running diff delver needs. ${error.unexpected.length > 0 ? `It holds ${error.unexpected.slice(0, 5).join(', ')}${error.unexpected.length > 5 ? ` and ${String(error.unexpected.length - 5)} more` : ''}, which it should not. ` : ''}${error.missing.length > 0 ? `It lacks ${error.missing.join(', ')}. ` : ''}Fix scripts/release-package.ts or the build, then pack it again. ${nothing}`;
		case 'StepFailed':
			return `The packed package failed when ${error.step}: ${error.detail} ${nothing} Run pnpm release:check on it locally to see the same failure.`;
		case 'WrongVersion':
			return `The packed package says "${error.printed}" when asked its version, not release ${error.wanted}. Build with DIFF_DELVER_RELEASE_VERSION=${error.wanted}, then pack it again. ${nothing}`;
		case 'PageDidNotAnswer':
			return `The packed package opened a diff, but its page did not answer: ${error.detail}. ${nothing}`;
		case 'RegistryAsked':
			return `Installing the packed package asked a registry for ${error.paths.join(', ')}, so it would not run exactly what was tested. Make the build bundle it (move it to devDependencies), then pack it again. ${nothing}`;
	}
}

export interface CheckReport {
	readonly version: CodeVersion;
	/** The first run of the command, with an empty npm cache: download, install and `--version`. */
	readonly firstRun: Milliseconds;
	/** What that first run downloaded from the address. */
	readonly downloaded: ByteSize;
	/** The next run, which opens a diff, with npx's copy in place: starting the daemon included. */
	readonly laterRun: Milliseconds;
	readonly entries: number;
}

interface Ran {
	readonly stdout: string;
	readonly stderr: string;
}

function runIn(
	program: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv
): Promise<Result<Ran, string>> {
	return new Promise((done) => {
		execFile(
			program,
			args,
			{ cwd, env, timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(error: ExecException | null, stdout, stderr) => {
				if (error === null) {
					done(ok({ stdout, stderr }));
					return;
				}
				const said = `${stderr}\n${stdout}`.trim().split('\n').slice(-6).join(' ');
				done(err(said === '' ? error.message : said));
			}
		);
	});
}

async function onPath(name: string): Promise<string | undefined> {
	for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
		if (directory === '') continue;
		const candidate = join(directory, name);
		if (
			await access(candidate).then(
				() => true,
				() => false
			)
		)
			return candidate;
	}
	return undefined;
}

/** A folder holding only links to the programs a newcomer has: node and what comes with it, git and a shell. */
async function newcomersPath(folder: string): Promise<Result<string, CheckError>> {
	await mkdir(folder);
	const nodeFolder = dirname(process.execPath);
	const tools: readonly (readonly [string, string | undefined])[] = [
		['node', process.execPath],
		['npm', join(nodeFolder, 'npm')],
		['npx', join(nodeFolder, 'npx')],
		['git', await onPath('git')],
		['sh', '/bin/sh']
	];
	for (const [name, path] of tools) {
		const found =
			path !== undefined &&
			(await access(path).then(
				() => true,
				() => false
			))
				? path
				: await onPath(name);
		if (found === undefined) return err({ kind: 'ToolMissing', tool: name });
		await symlink(found, join(folder, name));
	}
	return ok(folder);
}

interface TarballServer {
	readonly server: Server;
	readonly latest: string;
	readonly registry: string;
	/** Bytes of the tarball sent so far. */
	readonly sent: () => number;
	/** Requests for anything but the tarball, which a self-contained package never makes. */
	readonly others: readonly string[];
}

/** Serves the tarball as GitHub serves a release asset: the latest address redirects to the file. */
async function serveTarball(bytes: Buffer): Promise<TarballServer> {
	let sent = 0;
	const others: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? '';
		if (path === `/latest/download/${TARBALL_NAME}`) {
			response.writeHead(302, { location: `/download/v0/${TARBALL_NAME}` });
			response.end();
		} else if (path === `/download/v0/${TARBALL_NAME}`) {
			const head = request.method === 'HEAD';
			if (!head) sent += bytes.length;
			response.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': String(bytes.length)
			});
			response.end(head ? undefined : bytes);
		} else {
			others.push(path);
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((listening) => {
		server.listen(0, '127.0.0.1', listening);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The server has no port.');
	const origin = `http://127.0.0.1:${String(address.port)}`;
	return {
		server,
		latest: `${origin}/latest/download/${TARBALL_NAME}`,
		registry: `${origin}/registry/`,
		sent: () => sent,
		others
	};
}

/** Asks the address the command printed for its page, as a browser would: the entry code, then the page with its cookie. */
async function pageAnswers(address: string): Promise<Result<undefined, string>> {
	try {
		const entry = await fetch(address, { redirect: 'manual' });
		const cookie = entry.headers.get('set-cookie');
		const location = entry.headers.get('location');
		if (entry.status !== 303 || cookie === null || location === null) {
			return err(`the address answered ${String(entry.status)}, not a redirect with a cookie`);
		}
		const page = await fetch(new URL(location, address), {
			headers: { cookie: cookie.split(';')[0] ?? cookie }
		});
		const html = await page.text();
		if (page.status !== 200 || !html.includes('<title>')) {
			return err(`the page answered ${String(page.status)}`);
		}
		return ok(undefined);
	} catch (error) {
		return err(error instanceof Error ? error.message : String(error));
	}
}

export async function checkPackage(options: {
	readonly tarball: AbsolutePath;
	readonly version: ReleaseVersion | undefined;
}): Promise<Result<CheckReport, CheckError>> {
	const bytes = await readFile(options.tarball).catch(() => undefined);
	if (bytes === undefined) return err({ kind: 'NoTarball', path: options.tarball });

	const folder = await mkdtemp(join(tmpdir(), 'diff-delver-release-check-'));
	const served = await serveTarball(bytes);
	const home = join(folder, 'home');
	const data = join(folder, 'data');
	const repository = join(folder, 'repository');
	let env: NodeJS.ProcessEnv | undefined;
	/** Whether a daemon the check started may still be running. */
	let running = false;
	try {
		const listed = await runIn('tar', ['-tzf', options.tarball], folder, process.env);
		if (!listed.ok)
			return err({ kind: 'StepFailed', step: 'its contents were listed', detail: listed.error });
		const entries = listed.value.stdout.split('\n').filter((line) => line !== '');
		const unexpected = unexpectedEntries(entries);
		const missing = NEEDED_ENTRIES.filter((entry) => !entries.includes(entry));
		if (unexpected.length > 0 || missing.length > 0) {
			return err({ kind: 'WrongContents', unexpected, missing });
		}

		const path = await newcomersPath(join(folder, 'bin'));
		if (!path.ok) return path;
		await mkdir(home);
		await mkdir(repository);
		const newcomer: NodeJS.ProcessEnv = {
			HOME: home,
			PATH: path.value,
			// Nothing of the machine's: no git config, no npm config, no registry but the local server.
			GIT_CONFIG_NOSYSTEM: '1',
			npm_config_userconfig: join(home, '.npmrc'),
			npm_config_globalconfig: join(home, 'npmrc-global'),
			npm_config_registry: served.registry,
			npm_config_update_notifier: 'false',
			npm_config_audit: 'false',
			npm_config_fund: 'false',
			npm_config_loglevel: 'error'
		};
		env = newcomer;
		const npx = (args: readonly string[], cwd: string): Promise<Result<Ran, string>> =>
			runIn(join(path.value, 'npx'), ['--yes', served.latest, ...args], cwd, newcomer);

		const started = performance.now();
		const shown = await npx(['--version'], folder);
		const firstRun = millisecondsOf(Math.round(performance.now() - started));
		const downloaded = parseByteSize(served.sent());
		if (!downloaded.ok) throw new Error('A download has no size.');
		if (!shown.ok) {
			return err({
				kind: 'StepFailed',
				step: 'npx installed it and asked its version',
				detail: shown.error
			});
		}
		const printed = shown.value.stdout.trim();
		const version = parseCodeVersion(printed.replace(/^diff-delver /, ''));
		if (!printed.startsWith('diff-delver ') || !version.ok) {
			return err({
				kind: 'StepFailed',
				step: 'it was asked its version',
				detail: `it printed "${printed}"`
			});
		}
		if (options.version !== undefined && releaseOfCodeVersion(version.value) !== options.version) {
			return err({ kind: 'WrongVersion', wanted: options.version, printed });
		}

		const git = (args: readonly string[]): Promise<Result<Ran, string>> =>
			runIn(
				join(path.value, 'git'),
				[
					'-c',
					'user.name=Release check',
					'-c',
					'user.email=release-check@example.invalid',
					'-c',
					'init.defaultBranch=main',
					...args
				],
				repository,
				newcomer
			);
		await writeFile(join(repository, 'greeting.txt'), 'hello\n');
		for (const args of [
			['init', '--quiet'],
			['add', 'greeting.txt'],
			['commit', '--quiet', '-m', 'A greeting']
		]) {
			const done = await git(args);
			if (!done.ok)
				return err({
					kind: 'StepFailed',
					step: `git ${args[0] ?? ''} made a test repository`,
					detail: done.error
				});
		}
		await writeFile(join(repository, 'greeting.txt'), 'hello, world\n');

		const opening = performance.now();
		const opened = await npx(['--no-open', '--data-directory', data], repository);
		const laterRun = millisecondsOf(Math.round(performance.now() - opening));
		if (!opened.ok) {
			return err({
				kind: 'StepFailed',
				step: 'it opened a diff with --no-open',
				detail: opened.error
			});
		}
		const address = /Open this in your browser: (\S+)/.exec(opened.value.stdout)?.[1];
		if (address === undefined) {
			return err({
				kind: 'StepFailed',
				step: 'it opened a diff with --no-open',
				detail: `it printed no address: ${opened.value.stdout.trim()}`
			});
		}
		running = true;
		const answered = await pageAnswers(address);
		if (!answered.ok) return err({ kind: 'PageDidNotAnswer', detail: answered.error });

		const stopped = await npx(['stop', '--data-directory', data], repository);
		running = !stopped.ok;
		if (!stopped.ok || !stopped.value.stdout.includes('diff delver has stopped.')) {
			return err({
				kind: 'StepFailed',
				step: 'it was asked to stop',
				detail: stopped.ok ? stopped.value.stdout.trim() : stopped.error
			});
		}
		if (served.others.length > 0) return err({ kind: 'RegistryAsked', paths: [...served.others] });
		return ok({
			version: version.value,
			firstRun,
			laterRun,
			downloaded: downloaded.value,
			entries: entries.length
		});
	} finally {
		// A daemon left by a failed step would outlive the folder.
		if (running && env !== undefined) {
			await runIn(
				join(folder, 'bin', 'npx'),
				['--yes', served.latest, 'stop', '--data-directory', data],
				folder,
				env
			);
		}
		await new Promise((closed) => {
			served.server.close(closed);
			served.server.closeAllConnections();
		});
		await rm(folder, { recursive: true, force: true });
	}
}

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(resolve(path));
	if (!parsed.ok) throw new Error(`Not a path: ${path}`);
	return parsed.value;
}

function usage(problem: string): never {
	process.stderr.write(
		`${problem}\nUsage: node scripts/release-check.ts <tarball> [--version <release, such as 0.2.0>]\n`
	);
	process.exit(2);
}

async function main(args: readonly string[]): Promise<number> {
	let tarball: string | undefined;
	let version: ReleaseVersion | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === '--version' && next !== undefined) {
			const parsed = parseReleaseVersion(next);
			if (!parsed.ok)
				usage(`"${next}" is not a release version. Give three whole numbers, such as 0.2.0.`);
			version = parsed.value;
			i += 1;
		} else if (arg !== undefined && !arg.startsWith('-') && tarball === undefined) {
			tarball = arg;
		} else {
			usage(`"${arg ?? ''}" is not something this script takes.`);
		}
	}
	const checked = await checkPackage({
		tarball: absolute(tarball ?? join('release', TARBALL_NAME)),
		version
	});
	if (!checked.ok) {
		process.stderr.write(`${describeCheckError(checked.error)}\n`);
		return 1;
	}
	const report = checked.value;
	process.stdout.write(
		`The packed package works: npx installed diff delver ${report.version} from a local address in ${String(report.firstRun)} ms with an empty cache, opened a diff whose page answered, and stopped. The first run downloaded ${String(Math.round(report.downloaded / 1024))} KiB; the next, which opened the diff, took ${String(report.laterRun)} ms. The package holds ${String(report.entries)} entries.\n`
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
