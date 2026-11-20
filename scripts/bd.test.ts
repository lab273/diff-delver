/**
 * `pnpm bd` end to end, with the real bd, against a throwaway beads database in a
 * temporary directory. It never touches the project's own issue database: each
 * test runs in its own copy of a database made for this file, with its own home
 * directory, and pushes only to a local directory.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_ACTOR, AGENT_EMAIL } from './issue-tracker-identity.ts';

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dirname, 'bd.ts');
const PROJECT = join(import.meta.dirname, '..');

interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** A home directory whose git identity is a person's, as on a developer's machine. */
async function personalHome(dir: string): Promise<string> {
	const home = join(dir, 'home');
	await mkdir(home, { recursive: true });
	await writeFile(
		join(home, '.gitconfig'),
		'[user]\n\tname = Some Person\n\temail = some.person@example.org\n'
	);
	return home;
}

function environment(home: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env['PATH'] ?? '',
		HOME: home,
		USER: 'someperson',
		GIT_CONFIG_NOSYSTEM: '1',
		DO_NOT_TRACK: '1',
		BD_NO_REMOTE_ADOPT: '1',
		NO_COLOR: '1'
	};
}

/** Runs the wrapper in `cwd`, as `pnpm bd` would. */
async function wrapper(cwd: string, home: string, args: readonly string[]): Promise<Ran> {
	try {
		const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args], {
			cwd,
			env: environment(home)
		});
		return { code: 0, stdout, stderr };
	} catch (error: unknown) {
		const fields = new Map<string, unknown>(
			typeof error === 'object' && error !== null ? Object.entries(error) : []
		);
		const text = (key: string): string => {
			const value = fields.get(key);
			return typeof value === 'string' ? value : '';
		};
		const code = fields.get('code');
		return {
			code: typeof code === 'number' ? code : -1,
			stdout: text('stdout'),
			stderr: text('stderr')
		};
	}
}

let root = '';
let template = '';

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'diff-delver-bd-'));
	// Never the project's own database, which lives inside the project.
	expect(relative(PROJECT, root).startsWith('..')).toBe(true);
	template = join(root, 'template');
	await mkdir(template);
	const home = await personalHome(root);
	const init = await wrapper(template, home, [
		'init',
		'-p',
		'tt',
		'--quiet',
		'--non-interactive',
		'--skip-agents',
		'--skip-hooks'
	]);
	expect(init.code, init.stderr).toBe(0);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

let count = 0;

/** A fresh copy of the database, with a home and an empty local remote of its own. */
async function database(): Promise<{ db: string; home: string; remote: string }> {
	count += 1;
	const dir = join(root, `test-${String(count)}`);
	const db = join(dir, 'db');
	const remote = join(dir, 'remote');
	await cp(template, db, { recursive: true });
	await mkdir(remote, { recursive: true });
	const home = await personalHome(dir);
	const added = await wrapper(db, home, ['dolt', 'remote', 'add', 'origin', `file://${remote}`]);
	if (added.code !== 0) throw new Error(`Could not add the test remote: ${added.stderr}`);
	return { db, home, remote };
}

async function exported(db: string, home: string): Promise<readonly Record<string, unknown>[]> {
	const file = join(db, '..', 'export.jsonl');
	const ran = await wrapper(db, home, ['export', '--all', '-o', file]);
	if (ran.code !== 0) throw new Error(`Could not export the test database: ${ran.stderr}`);
	const text = await readFile(file, 'utf8');
	return text
		.split('\n')
		.filter((line) => line !== '')
		.map((line): Record<string, unknown> => {
			const parsed: unknown = JSON.parse(line);
			return typeof parsed === 'object' && parsed !== null
				? Object.fromEntries(Object.entries(parsed))
				: {};
		});
}

// Each test has its own copy of the database, so they run at once. Concurrent
// tests take `expect` from their context, so each counts its own assertions.
describe.concurrent('pnpm bd', () => {
	it('records the agent identity, not the git one, and passes output and exit status through', async ({
		expect
	}) => {
		const { db, home } = await database();
		const created = await wrapper(db, home, [
			'create',
			'A task',
			'-d',
			'Something to do',
			'--json'
		]);
		expect(created.code, created.stderr).toBe(0);
		expect(created.stdout).toContain('"title": "A task"');

		const [issue] = await exported(db, home);
		expect(issue?.['owner']).toBe(AGENT_EMAIL);
		expect(issue?.['created_by']).toBe(AGENT_ACTOR);

		const missing = await wrapper(db, home, ['show', 'tt-nothing']);
		expect(missing.code).toBe(1);
		expect(missing.stdout + missing.stderr).toContain('not found');
	});

	it('pushes issue data that holds nothing personal', async ({ expect }) => {
		const { db, home, remote } = await database();
		await wrapper(db, home, ['create', 'Clean task', '-d', 'Fixed in ca38afac.']);
		const pushed = await wrapper(db, home, ['push']);
		expect(pushed.code, pushed.stderr).toBe(0);
		expect(pushed.stdout).toContain('nothing personal or sensitive found');
		expect(await readdir(remote)).not.toEqual([]);
	});

	it('refuses to push an email address, naming the issue and field, and pushes nothing', async ({
		expect
	}) => {
		const { db, home, remote } = await database();
		const created = await wrapper(db, home, [
			'create',
			'Ask',
			'-d',
			'Mail jo@example.com',
			'--json'
		]);
		const id = /"id": "([^"]+)"/.exec(created.stdout)?.[1];
		expect(id).toBeDefined();

		for (const args of [['push'], ['dolt', 'push']]) {
			const refused = await wrapper(db, home, args);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain('Nothing was pushed');
			expect(refused.stderr).toContain(`${String(id)} description: an email address`);
		}
		expect(await readdir(remote)).toEqual([]);
	});

	it('refuses to push a term from the private-terms file, in any case', async ({ expect }) => {
		const { db, home, remote } = await database();
		await writeFile(join(db, '.beads', 'private-terms.txt'), '# clients\nAcme Widgets\n');
		await wrapper(db, home, ['create', 'Report for ACME WIDGETS']);
		const refused = await wrapper(db, home, ['push']);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('title: a term from the private-terms file: ACME WIDGETS');
		expect(await readdir(remote)).toEqual([]);
	});
});
