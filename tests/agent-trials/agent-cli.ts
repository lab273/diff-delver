/**
 * What the trial harness (`run.ts`) hands an agent's CLI, and how it runs one,
 * apart from the harness so it can be tested without starting a session:
 *
 * - the exact arguments and settings each CLI is given, which are what keeps
 *   the agent to reading the trial's copy of the repository (docs/DEVELOPING.md, "Agent
 *   trials", and tests/agent-trials/README.md say what each enforces);
 * - the person's login, linked into the trial's home and taken out again on
 *   every exit, with a login the CLI refreshed during the run put back;
 * - running a program to its end or a time limit, its whole process group
 *   stopped, so neither a CLI nor anything it started outlives the trial.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

// --- What each CLI is given ---------------------------------------------------------

/** A Claude Code permission rule's path, absolute from the root of the disk: `//tmp/x/**`. */
function absoluteRule(tool: string, folder: string): string {
	return `${tool}(/${folder.replace(/\/+$/, '')}/**)`;
}

export interface ClaudeTrial {
	readonly prompt: string;
	readonly model: string;
	readonly turnLimit: number;
	/** The trial's copy of the repository: the working directory, and all the agent may read. */
	readonly repository: string;
	/** The trial's home folder, which holds the link to the login. */
	readonly home: string;
	/** Where the person's login is, which the agent must never read. */
	readonly loginFolder: string;
	readonly mcpConfig: string;
	/** The plugin folder holding the skill, or undefined for a trial without it. */
	readonly plugin: string | undefined;
}

/**
 * Claude Code's arguments. Its tools are only Read, Grep and Glob (and Skill
 * with the skill): no shell, so nothing it runs can write or read beyond them.
 * Reads are allowed in the repository only; in `dontAsk` mode, with nobody to
 * ask, anything no rule allows is refused, and the trial's home and the login's
 * folder are denied outright as well.
 */
export function claudeArguments(trial: ClaudeTrial): readonly string[] {
	const skill = trial.plugin !== undefined;
	return [
		'-p',
		trial.prompt,
		'--model',
		trial.model,
		'--output-format',
		'stream-json',
		'--verbose',
		'--no-session-persistence',
		'--strict-mcp-config',
		'--mcp-config',
		trial.mcpConfig,
		'--permission-mode',
		'dontAsk',
		'--permission-prompts',
		'none',
		'--tools',
		skill ? 'Read,Grep,Glob,Skill' : 'Read,Grep,Glob',
		'--allowedTools',
		absoluteRule('Read', trial.repository),
		'mcp__diff-delver',
		...(skill ? ['Skill'] : []),
		'--disallowedTools',
		'Bash',
		'Edit',
		'Write',
		'NotebookEdit',
		'WebFetch',
		'WebSearch',
		absoluteRule('Read', trial.home),
		absoluteRule('Read', trial.loginFolder),
		'--max-turns',
		String(trial.turnLimit),
		...(skill ? ['--plugin-dir', trial.plugin] : [])
	];
}

/** Codex features that would reach beyond the trial, switched off. */
export const CODEX_FEATURES_OFF = [
	'apps',
	'browser_use',
	'browser_use_external',
	'computer_use',
	'in_app_browser',
	'image_generation',
	'plugins',
	'remote_plugin',
	'plugin_sharing',
	'goals',
	'hooks',
	'tool_suggest',
	'skill_mcp_dependency_install',
	// Reads an image from any path, outside the sandbox.
	'view_image'
] as const;

/** The name of the permission profile the trial gives Codex. */
export const CODEX_PROFILE = 'trial';

const toml = (value: string): string => JSON.stringify(value);

export interface CodexTrial {
	readonly model: string;
	readonly repository: string;
	/** The folder Codex is installed in: its sandbox runs Codex itself again, so it must read it. */
	readonly installation: string;
	/** The skills in Codex's home, ours among them, which the agent reads with a command. */
	readonly skills: string;
	readonly server: { readonly command: string; readonly args: readonly string[] };
}

/**
 * Codex's `config.toml`. Its commands run in a sandbox with a permission
 * profile of the trial's own: the repository, the folder Codex is installed in
 * and the skills in its home may be read, with the system's own folders
 * (`:minimal`), and nothing may be written. The rest of its home, which holds
 * the link to the login, is not readable.
 */
export function codexConfig(trial: CodexTrial): string {
	return [
		`model = ${toml(trial.model)}`,
		'approval_policy = "never"',
		`default_permissions = ${toml(CODEX_PROFILE)}`,
		'',
		`[permissions.${CODEX_PROFILE}.filesystem]`,
		'":minimal" = "read"',
		`${toml(trial.repository)} = "read"`,
		`${toml(trial.installation)} = "read"`,
		`${toml(trial.skills)} = "read"`,
		'',
		'[features]',
		...CODEX_FEATURES_OFF.map((f) => `${f} = false`),
		'',
		// No sub-agents: one agent, whose every call the proxy sees.
		'[agents]',
		'enabled = false',
		'',
		// Trusted so that our MCP server runs as configured; the agent's own
		// commands still run in the sandbox.
		`[projects.${toml(trial.repository)}]`,
		'trust_level = "trusted"',
		'',
		'[mcp_servers.diff-delver]',
		`command = ${toml(trial.server.command)}`,
		`args = [${trial.server.args.map(toml).join(', ')}]`,
		'startup_timeout_sec = 60',
		'tool_timeout_sec = 300',
		'default_tools_approval_mode = "approve"',
		''
	].join('\n');
}

/** `codex exec`'s arguments: the sandbox comes from the profile, never a flag that loosens it. */
export function codexArguments(trial: {
	readonly prompt: string;
	readonly model: string;
	readonly repository: string;
	readonly lastMessage: string;
}): readonly string[] {
	return [
		'exec',
		'--json',
		'--strict-config',
		'--ephemeral',
		'--ignore-rules',
		'-m',
		trial.model,
		'-C',
		trial.repository,
		'-o',
		trial.lastMessage,
		trial.prompt
	];
}

/**
 * The folder a CLI is installed in, found from its executable: the folder that
 * holds the folder of the file it resolves to (`…/codex/0.170.0` for
 * `…/codex/0.170.0/bin/codex`).
 */
export function installationOf(executable: string): string {
	return dirname(dirname(realpathSync(executable)));
}

// --- The login ---------------------------------------------------------------------

export type LoginCli = 'claude' | 'codex';

/** How long before its expiry a login must not be used: a refresh during the run is likely then. */
export const LOGIN_MARGIN_MS = 20 * 60_000;

const ClaudeLogin = z
	.object({ claudeAiOauth: z.object({ expiresAt: z.number() }).loose() })
	.loose();
const CodexLogin = z.object({ tokens: z.object({ access_token: z.string() }).loose() }).loose();
const TokenClaims = z.object({ exp: z.number() }).loose();

/**
 * When a CLI's login expires, in milliseconds since 1970, if its file says:
 * Claude Code's `expiresAt`, or the `exp` of the access token Codex keeps.
 */
export function loginExpiresAt(cli: LoginCli, text: string): number | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	switch (cli) {
		case 'claude': {
			const login = ClaudeLogin.safeParse(json);
			return login.success ? login.data.claudeAiOauth.expiresAt : undefined;
		}
		case 'codex': {
			const login = CodexLogin.safeParse(json);
			if (!login.success) return undefined;
			const payload = login.data.tokens.access_token.split('.')[1];
			if (payload === undefined) return undefined;
			try {
				const claims = TokenClaims.safeParse(
					JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
				);
				return claims.success ? claims.data.exp * 1000 : undefined;
			} catch {
				return undefined;
			}
		}
	}
}

const CLI_NAMES: Readonly<Record<LoginCli, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** Refuses a login due to be refreshed soon, saying what to do; one that says no expiry passes. */
export function checkLoginFresh(cli: LoginCli, path: string, now: number): void {
	if (!existsSync(path)) {
		throw new Error(`No login at ${path}: log in to the CLI first, then run the trial again.`);
	}
	const expires = loginExpiresAt(cli, readFileSync(path, 'utf8'));
	if (expires !== undefined && expires - now < LOGIN_MARGIN_MS) {
		throw new Error(
			`Your ${CLI_NAMES[cli]} login is due to be refreshed within 20 minutes. Use ${cli} once so it refreshes, then run the trial again.`
		);
	}
}

/** The person's login, linked into a trial's home. */
export interface LinkedLogin {
	/** Where the CLI keeps the login, as the person has it. */
	readonly real: string;
	/** The file that is, with links followed. */
	readonly target: string;
	readonly link: string;
	/** Its content when linked, to tell whether the person's own copy changed meanwhile. */
	readonly digest: string;
}

function digestOf(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Links the CLI's login into the trial's home, never copying it. */
export function linkLogin(real: string, link: string): LinkedLogin {
	if (!existsSync(real)) {
		throw new Error(`No login at ${real}: log in to the CLI first, then run the trial again.`);
	}
	const target = realpathSync(real);
	const login = { real, target, link, digest: digestOf(target) };
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(target, link);
	return login;
}

/**
 * Takes the link out of the trial's home, synchronously, so it can run as the
 * process exits. A CLI that refreshed its login may have replaced the link with
 * the fresh login; that is put back over the person's own, in one rename, when
 * theirs did not change meanwhile, and otherwise kept beside it. Says what it
 * did in that case, for the person to read whatever the trial's outcome.
 */
export function releaseLogin(login: LinkedLogin, now: Date): readonly string[] {
	let link;
	try {
		link = lstatSync(login.link);
	} catch {
		return [];
	}
	if (link.isSymbolicLink()) {
		rmSync(login.link, { force: true });
		return [];
	}
	const fresh = readFileSync(login.link);
	const ownUnchanged = existsSync(login.target) && digestOf(login.target) === login.digest;
	if (ownUnchanged) {
		const temporary = `${login.target}.diff-delver-trial-${String(process.pid)}`;
		try {
			writeFileSync(temporary, fresh, {
				mode: statSync(login.target).mode & 0o777,
				flag: 'wx'
			});
			renameSync(temporary, login.target);
			rmSync(login.link, { force: true });
			return [
				`The CLI refreshed its login during the trial. The refreshed login was put in place of yours at ${login.real}, since the one there was refreshed.`
			];
		} catch {
			rmSync(temporary, { force: true });
		}
	}
	const kept = `${login.target}.from-trial-${now.toISOString().replace(/[:.]/g, '-')}`;
	try {
		writeFileSync(kept, fresh, { mode: 0o600, flag: 'wx' });
		rmSync(login.link, { force: true });
		return [
			`The CLI refreshed its login during the trial, and yours at ${login.real} ${ownUnchanged ? 'could not be replaced' : 'changed meanwhile'}, so it was left as it is. The refreshed login is kept at ${kept}: if the CLI asks you to log in again, move that file over yours, or log in.`
		];
	} catch (error) {
		rmSync(login.link, { force: true });
		return [
			`The CLI refreshed its login during the trial, but the refreshed login could not be kept (${error instanceof Error ? error.message : String(error)}). If the CLI asks you to log in again, log in.`
		];
	}
}

// --- Running a CLI -------------------------------------------------------------------

/** After the time limit, how long a CLI has to stop when asked before it is killed. */
const GRACE_MS = 5_000;
/** After a CLI exits, how long what it started may hold its output open. */
const DRAIN_MS = 2_000;

/** The process groups of the programs running now, to stop if the harness has to exit at once. */
const runningGroups = new Set<number>();

function signalGroup(leader: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-leader, signal);
	} catch {
		// Nothing left in the group.
	}
}

/** Kills every program the harness started and everything they started, at once. */
export function killEveryGroup(): void {
	for (const leader of runningGroups) signalGroup(leader, 'SIGKILL');
	runningGroups.clear();
}

export interface BoundedRun {
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** Stopped because the harness was asked to stop. */
	readonly stopped: boolean;
	readonly code: number | null;
	/** Why the program could not be started, such as it not being installed. */
	readonly error: string | null;
}

/**
 * Runs a program, with no shell, in a process group of its own, to its end or
 * the time limit, collecting what it printed. At the limit, or when `stop`
 * aborts, the whole group is asked to stop, then killed; when the program
 * exits, whatever it left running is stopped too. It never waits on output
 * that something left behind holds open: it is done at most a few seconds
 * after the program exits or the limit passes.
 */
export function runBounded(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly limitMs: number;
		readonly stop?: AbortSignal;
	}
): Promise<BoundedRun> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let stopped = false;
		let code: number | null = null;
		let error: string | null = null;
		let settled = false;
		const timers: NodeJS.Timeout[] = [];
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true
		});
		const leader = child.pid;
		if (leader !== undefined) runningGroups.add(leader);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			options.stop?.removeEventListener('abort', onStop);
			if (leader !== undefined) {
				signalGroup(leader, 'SIGKILL');
				runningGroups.delete(leader);
			}
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ stdout, stderr, timedOut, stopped, code, error });
		};
		const end = (): void => {
			if (leader === undefined) return;
			signalGroup(leader, 'SIGTERM');
			timers.push(
				setTimeout(() => {
					signalGroup(leader, 'SIGKILL');
				}, GRACE_MS)
			);
			timers.push(setTimeout(finish, GRACE_MS + DRAIN_MS));
		};
		function onStop(): void {
			stopped = true;
			end();
		}
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
		child.on('error', (failure) => {
			error = failure.message;
			if (leader === undefined) finish();
		});
		child.on('exit', (exitCode) => {
			code = exitCode;
			if (leader !== undefined) signalGroup(leader, 'SIGTERM');
			timers.push(setTimeout(finish, DRAIN_MS));
		});
		child.on('close', finish);
		timers.push(
			setTimeout(() => {
				timedOut = true;
				end();
			}, options.limitMs)
		);
		if (options.stop?.aborted === true) onStop();
		else options.stop?.addEventListener('abort', onStop, { once: true });
	});
}
