/**
 * The rules for releasing (README, "How we work" and "Releasing"), held to: the
 * release workflow runs only when started by hand, packs only after every test
 * passed, lets only its last job write, and never touches npm; nothing else in
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

	it('gives no permission to the workflow, and lets only the releasing job write', async () => {
		const text = code(await workflow('release.yml'));
		expect(text).toMatch(/^permissions: \{\}$/m);
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
			expect(text, name).not.toMatch(/gh release|releases|git tag|git push|contents: write/);
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
		const refused = await new Promise<{ code: number; stdout: string }>((done) => {
			execFile(
				process.execPath,
				[script],
				{ env: { ...env, RELEASE_VERSION: '0.2.0' } },
				(error, stdout) => {
					done({
						code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
						stdout
					});
				}
			);
		});
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain(
			'::error title=The release was refused::A tag named v0.2.0 already exists'
		);
		expect(await readFile(output, 'utf8')).toBe('');
	});
});
