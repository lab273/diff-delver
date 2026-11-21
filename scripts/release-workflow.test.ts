/**
 * The rules for releasing (docs/DEVELOPING.md, "How we work" and "Releasing"), held to: the
 * release workflow runs only when started by hand, packs only after every test
 * passed, lets only its last job write, checks everything again just before it
 * creates the release, runs its steps in bash with pipefail, and never touches npm; nothing else in
 * the repository makes a release or a tag; and the package stays private. Also
 * the release's first checks (`release-preflight.ts`), run as the workflow
 * runs them.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDirectory } from '../tests/support/fixture-repos.ts';
import { describeProblem, preflight, type PreflightInput } from './release-preflight.ts';

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const run = promisify(execFile);

async function workflow(name: string): Promise<string> {
	return readFile(join(WORKFLOWS, name), 'utf8');
}

/** The lines of a top-level key's block, such as `on:` or `jobs:`, without the key's own line. */
function block(text: string, key: string): readonly string[] {
	const lines = text.split('\n');
	const start = lines.indexOf(`${key}:`);
	if (start === -1) return [];
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^\S/.test(line) && !line.startsWith('#'));
	return end === -1 ? rest : rest.slice(0, end);
}

/** The names of the keys directly under a block, at two spaces. */
function keysOf(lines: readonly string[]): readonly string[] {
	return lines
		.map((line) => /^ {2}([A-Za-z_][\w-]*):/.exec(line)?.[1])
		.filter((key) => key !== undefined);
}

/** Each job of a workflow, as its lines. */
function jobs(text: string): ReadonlyMap<string, string> {
	const lines = block(text, 'jobs');
	const found = new Map<string, string>();
	let name: string | undefined;
	let body: string[] = [];
	for (const line of lines) {
		const key = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line)?.[1];
		if (key !== undefined) {
			if (name !== undefined) found.set(name, body.join('\n'));
			name = key;
			body = [];
		} else {
			body.push(line);
		}
	}
	if (name !== undefined) found.set(name, body.join('\n'));
	return found;
}

/** A job's steps, each as its lines, in order. */
function steps(body: string): readonly string[] {
	const found: string[][] = [];
	for (const line of body.split('\n')) {
		if (/^ {6}- /.test(line)) found.push([line]);
		else if (/^ {8}/.test(line)) found.at(-1)?.push(line);
	}
	return found.map((step) => step.join('\n'));
}

/** The workflow without its comments, so a rule is not met or broken by a comment. */
function code(text: string): string {
	return text
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n');
}

const PUBLISHING = [
	/\bnpm\s+publish\b/,
	/\bpnpm\s+publish\b/,
	/\byarn\s+(npm\s+)?publish\b/,
	/\bnpm\s+(dist-tag|owner|access|adduser|login|token)\b/,
	/NODE_AUTH_TOKEN/,
	/NPM_TOKEN/,
	/registry-url/,
	/registry\.npmjs\.org/
];

describe('the release workflow', () => {
	it('runs only when a person starts it, with a version and the commit they expect', async () => {
		const text = await workflow('release.yml');
		const on = block(text, 'on');
		expect(keysOf(on)).toEqual(['workflow_dispatch']);
		expect(on.join('\n')).toMatch(/^ {6}version:$/m);
		expect(on.join('\n')).toMatch(/^ {6}commit:$/m);
		expect(text).not.toMatch(/^on:[ \t]*\S/m);
	});

	it('packs only after every test passed, and releases only after the packed package was tried', async () => {
		const text = code(await workflow('release.yml'));
		const found = jobs(text);
		expect([...found.keys()]).toEqual(['check', 'verify', 'package', 'release']);
		expect(found.get('verify')).toMatch(/needs: check/);
		expect(found.get('verify')).toMatch(/run: pnpm verify\n/);
		expect(found.get('package')).toMatch(/needs: \[check, verify\]/);
		expect(found.get('package')).toMatch(/pnpm release:check /);
		expect(found.get('release')).toMatch(/needs: \[check, verify, package\]/);
		// A job that ran after a failure, or a step whose failure is ignored, could release untested code.
		expect(text).not.toMatch(/always\(\)|cancelled\(\)|continue-on-error|!\s*failure\(\)/);
		for (const [name, body] of found) {
			const conditions = body.split('\n').filter((line) => /^ {4}if:/.test(line));
			expect(conditions, `job ${name} has a condition`).toEqual([]);
		}
	});

	it('checks everything again, from the same scripts, just before it creates the release', async () => {
		const found = jobs(code(await workflow('release.yml')));
		const first = steps(found.get('check') ?? '');
		const last = steps(found.get('release') ?? '');
		const firstCheck = first.findIndex((step) =>
			step.includes('node scripts/release-preflight.ts')
		);
		expect(first[firstCheck - 1]).toMatch(/run: scripts\/release-names\.sh$/);
		expect(first[firstCheck]).toMatch(/STAGE: before-tests\n/);

		// A re-run of the releasing job alone repeats none of the first job, so
		// the check right before creating the release is the one that counts.
		const creates = last.findIndex((step) => step.includes('gh release create'));
		expect(creates).toBeGreaterThan(1);
		expect(last.filter((step) => step.includes('gh release create'))).toHaveLength(1);
		expect(last[creates - 1]).toMatch(/run: node scripts\/release-preflight\.ts$/);
		expect(last[creates - 1]).toMatch(/STAGE: before-release\n/);
		expect(last[creates - 1]).toMatch(/RELEASE_VERSION: \$\{\{ inputs\.version \}\}\n/);
		expect(last[creates - 1]).toMatch(/EXPECTED_COMMIT: \$\{\{ inputs\.commit \}\}\n/);
		expect(last[creates - 2]).toMatch(/run: scripts\/release-names\.sh$/);
		expect(last[creates]).toMatch(/--latest\b/);
	});

	it('runs every step in bash, so a failing command in a pipeline fails its step', async () => {
		for (const name of ['release.yml', 'verify.yml']) {
			const text = code(await workflow(name));
			expect(text, name).toMatch(/^defaults:\n {2}run:\n {4}shell: bash$/m);
			expect(text, name).not.toMatch(/^\s+shell:(?! bash$)/m);
		}
	});

	it('says what to do when the releasing job fails after it began creating the release', async () => {
		const last = steps(jobs(code(await workflow('release.yml'))).get('release') ?? '');
		const said = last.at(-1) ?? '';
		expect(said).toMatch(/if: failure\(\) && steps\.create\.outcome != 'skipped'\n/);
		expect(said).toContain('delete the release and the tag $TAG on GitHub');
		expect(last.find((step) => step.includes('gh release create'))).toMatch(/id: create\n/);
	});

	it('gives no permission to the workflow, and lets only the releasing job write', async () => {
		const text = code(await workflow('release.yml'));
		expect(text).toMatch(/^permissions: \{\}$/m);
		expect(text).not.toMatch(/write-all/);
		for (const [name, body] of jobs(text)) {
			const permissions = /^ {4}permissions:\n((?: {6}.+\n?)+)/m.exec(body)?.[1]?.trim();
			expect(permissions, `job ${name}`).toBe(
				name === 'release' ? 'contents: write' : 'contents: read'
			);
		}
	});

	it('never touches npm', async () => {
		const text = code(await workflow('release.yml'));
		for (const rule of PUBLISHING) expect(text).not.toMatch(rule);
	});

	it('is the only thing that makes a release, a release tag or a release asset', async () => {
		const names = await readdir(WORKFLOWS);
		expect(names.toSorted()).toEqual(['release.yml', 'verify.yml']);
		for (const name of names.filter((other) => other !== 'release.yml')) {
			const text = code(await workflow(name));
			expect(text, name).not.toMatch(
				/gh release|releases|git tag|git push|contents: write|write-all/
			);
			for (const rule of PUBLISHING) expect(text, name).not.toMatch(rule);
		}
	});
});

describe('the package', () => {
	it('stays private, with nothing that publishes it', async () => {
		const manifest: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
		expect(manifest).toMatchObject({ private: true });
		const text = JSON.stringify(manifest);
		expect(text).not.toMatch(/publishConfig|publish/);
	});
});

const fine: PreflightInput = {
	stage: 'before-tests',
	version: '0.3.0',
	expectedCommit: 'abc1234',
	commit: 'abc1234def5678abc1234def5678abc1234def56',
	ref: 'refs/heads/main',
	tags: ['v0.1.0', 'v0.2.0', 'something-else'],
	releases: ['v0.1.0', 'v0.2.0']
};

function problemsOf(input: PreflightInput): readonly string[] {
	const checked = preflight(input);
	return checked.ok ? [] : checked.error.map((problem) => problem.kind);
}

describe("the release's first checks", () => {
	it('pass a later version, on main, at the commit expected', () => {
		expect(preflight(fine)).toEqual({ ok: true, value: { version: '0.3.0', tag: 'v0.3.0' } });
		expect(preflight({ ...fine, tags: [], releases: [] }).ok).toBe(true);
		expect(preflight({ ...fine, expectedCommit: 'ABC1234DEF' }).ok).toBe(true);
	});

	it('refuse a version that is malformed, not after the newest release, or taken', () => {
		expect(problemsOf({ ...fine, version: 'v0.3.0' })).toEqual(['InvalidVersion']);
		expect(problemsOf({ ...fine, version: '0.3' })).toEqual(['InvalidVersion']);
		expect(problemsOf({ ...fine, version: '0.1.5' })).toEqual(['NotNewer']);
		expect(problemsOf({ ...fine, version: '0.10.0', releases: ['v0.9.0'] })).toEqual([]);
		expect(problemsOf({ ...fine, version: '0.2.0' })).toEqual(['TagExists', 'ReleaseExists']);
		expect(problemsOf({ ...fine, releases: [...fine.releases, 'v0.3.0'] })).toEqual([
			'ReleaseExists'
		]);
		expect(problemsOf({ ...fine, version: '0.2.5', tags: [...fine.tags, 'v0.4.0'] })).toEqual([
			'NotNewer'
		]);
	});

	it('before the release, refuse a name taken by a release, a draft or a tag, and a version a newer release passed', () => {
		const last: PreflightInput = { ...fine, stage: 'before-release' };
		expect(preflight(last).ok).toBe(true);
		expect(problemsOf({ ...last, releases: [...fine.releases, 'v0.3.0'] })).toEqual(['NameTaken']);
		expect(problemsOf({ ...last, tags: [...fine.tags, 'v0.3.0'] })).toEqual(['NameTaken']);
		expect(problemsOf({ ...last, version: '0.2.0' })).toEqual(['NameTaken']);
		// A re-run of a run for 0.3.0 after 0.4.0 was released.
		expect(
			problemsOf({
				...last,
				tags: [...fine.tags, 'v0.4.0'],
				releases: [...fine.releases, 'v0.4.0']
			})
		).toEqual(['NotNewer']);
		const taken = preflight({ ...last, releases: [...fine.releases, 'v0.3.0'] });
		expect(taken.ok ? [] : taken.error.map(describeProblem)).toEqual([
			'A release or a tag named v0.3.0 already exists, perhaps as a draft, which only this last check can see, or left by an earlier attempt of this run. Nothing was released. Look at the releases and tags on GitHub: if that release was made by mistake or is incomplete, delete the release and the tag v0.3.0, then start the release again; otherwise start it again with a later version.'
		]);
	});

	it('refuse a run on another branch, or on a commit other than the one expected', () => {
		expect(problemsOf({ ...fine, ref: 'refs/heads/feature' })).toEqual(['NotMain']);
		expect(problemsOf({ ...fine, ref: 'refs/tags/v0.3.0' })).toEqual(['NotMain']);
		expect(problemsOf({ ...fine, expectedCommit: 'def5678' })).toEqual(['UnexpectedCommit']);
		expect(problemsOf({ ...fine, expectedCommit: 'abc12' })).toEqual(['InvalidExpectedCommit']);
		expect(problemsOf({ ...fine, expectedCommit: 'main' })).toEqual(['InvalidExpectedCommit']);
		expect(
			problemsOf({ ...fine, ref: 'refs/heads/x', version: 'next', expectedCommit: '' })
		).toEqual(['NotMain', 'InvalidExpectedCommit', 'InvalidVersion']);
	});

	it('say what is wrong and what to do', () => {
		const checked = preflight({ ...fine, version: '0.1.5', expectedCommit: 'def5678' });
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.error.map(describeProblem)).toEqual([
			"main is at abc1234def56, not def5678, the commit you expected: something was pushed after you looked, or the id is wrong. Look at main's history, then start the release again with the commit you mean to release.",
			'Version 0.1.5 is not after the newest release, 0.2.0. Give a later version, such as 0.2.1, and start the release again.'
		]);
	});

	it('run as the workflow runs them, writing the version and tag for the later jobs', async () => {
		const folder = await tempDirectory();
		const tags = join(folder, 'tags.txt');
		const releases = join(folder, 'releases.txt');
		const output = join(folder, 'output');
		await writeFile(tags, 'v0.1.0\nv0.2.0\n');
		await writeFile(releases, 'v0.2.0\n');
		await writeFile(output, '');
		const env = {
			PATH: process.env['PATH'] ?? '',
			STAGE: 'before-tests',
			RELEASE_VERSION: '0.3.0',
			EXPECTED_COMMIT: 'abc1234',
			COMMIT: fine.commit,
			REF: 'refs/heads/main',
			TAGS_FILE: tags,
			RELEASES_FILE: releases,
			GITHUB_OUTPUT: output
		};
		const script = join(import.meta.dirname, 'release-preflight.ts');
		const passed = await run(process.execPath, [script], { env });
		expect(passed.stdout).toContain('Releasing 0.3.0 as v0.3.0');
		expect(await readFile(output, 'utf8')).toBe('version=0.3.0\ntag=v0.3.0\n');

		await writeFile(output, '');
		const refused = await exitOf(process.execPath, [script], { ...env, RELEASE_VERSION: '0.2.0' });
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain(
			'::error title=The release was refused::A tag named v0.2.0 already exists'
		);
		expect(await readFile(output, 'utf8')).toBe('');
	});

	it('refuse to run without being told which check they are', async () => {
		const script = join(import.meta.dirname, 'release-preflight.ts');
		const refused = await exitOf(process.execPath, [script], {
			PATH: process.env['PATH'] ?? '',
			RELEASE_VERSION: '0.3.0'
		});
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain('not before-tests or before-release');
	});
});

describe('listing the names a release could clash with', () => {
	it('fails when the tags cannot be listed, rather than finding none', async () => {
		// A repository with no remote called origin: git ls-remote fails.
		const folder = await tempDirectory();
		await run('git', ['init', '--quiet', folder]);
		const tags = join(folder, 'tags.txt');
		const listed = await exitOf(
			join(import.meta.dirname, 'release-names.sh'),
			[],
			{
				PATH: process.env['PATH'] ?? '',
				HOME: folder,
				GIT_CONFIG_NOSYSTEM: '1',
				TAGS_FILE: tags,
				RELEASES_FILE: join(folder, 'releases.txt')
			},
			folder
		);
		expect(listed.code).not.toBe(0);
		await expect(readFile(tags, 'utf8')).rejects.toThrow();
	});
});

/** Runs a program to its end, giving its exit code and what it printed, whether or not it failed. */
function exitOf(
	program: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd?: string
): Promise<{ code: number; stdout: string }> {
	return new Promise((done) => {
		execFile(program, args, { env, ...(cwd === undefined ? {} : { cwd }) }, (error, stdout) => {
			done({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout });
		});
	});
}
