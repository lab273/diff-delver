/**
 * `pnpm trials:run [--agent claude|codex|scripted] [--fixture shop|ledger] [--without-skill]`:
 * one agent trial (tests/agent-trials/README.md). A real coding agent, headless,
 * sorts a fixture repository's diff through our MCP server, and what it did is
 * written to `recordings/` for the replay and the journeys.
 *
 * Run by hand only: `claude` and `codex` spend the person's subscription.
 * `scripted` is the stand-in, the scripted categorisation behind the same
 * proxy, which costs nothing and is for working on the harness.
 *
 * What the agent gets, and nothing else of the person's:
 * - a copy of the fixture repository in a fresh temporary folder outside this
 *   repository, so none of this project's instructions reach it;
 * - a home folder of its own (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the
 *   XDG folders), holding only a link to the CLI's login and the skill when
 *   the trial gives it: none of the person's MCP servers, plugins, skills,
 *   memory, instructions or settings;
 * - our MCP server only, as `diff-delver mcp --no-open` with a data folder of
 *   the trial's own, behind the recording proxy (`proxy.ts`), reaching a daemon
 *   in this process with the journeys' fixed clock and sequential ids;
 * - tools that read the trial's copy of the repository and write nothing, as
 *   `agent-cli.ts` sets them out: Claude Code has Read, Grep and Glob, no shell,
 *   and may read only the repository; Codex runs its commands in a sandbox
 *   that may read the repository and the system's own folders and write
 *   nothing. Neither is ever given a flag that skips permissions or the sandbox.
 *
 * Whatever way the run ends (finished, failed, at the time limit, interrupted
 * with Ctrl-C or SIGTERM, a CLI that is not installed, any error), the CLI and
 * everything it started are stopped, the daemon stops, the link to the login
 * is taken out (a login the CLI refreshed meanwhile put back, and said so), and
 * the temporary folder is removed. An interrupted run records nothing.
 *
 * The run is bounded by `--time-limit` (ten minutes by default) and, for Claude
 * Code, a turn limit; hitting one is a result, recorded as such.
 *
 * To test the harness itself with stand-ins: `--cli <executable>` runs another
 * program in the CLI's place, `--login-from <folder>` takes the login from
 * another folder than the CLI's own, and `--out <folder>` writes the recording
 * and the transcript there instead of `recordings/` and `transcripts/`.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { BUILT_COMMAND, ensureBuild } from '../support/build.ts';
import {
	checkLoginFresh,
	claudeArguments,
	codexArguments,
	codexConfig,
	installationOf,
	killEveryGroup,
	linkLogin,
	releaseLogin,
	runBounded,
	type LinkedLogin
} from './agent-cli.ts';
import { listDirectory } from '../support/directory-listing.ts';
import { absolutePath, GitRepo } from '../support/git-repo.ts';
import type { McpSession } from '../support/mcp-client.ts';
import { categoriseShop } from '../support/scripted-categorisation.ts';
import {
	AGENTS,
	forbiddenIn,
	normaliseDeep,
	normaliser,
	readProxyLog,
	recordingName,
	RecordingSchema,
	type AgentName,
	type Recording
} from './recording.ts';
import {
	RECORDINGS_DIRECTORY,
	sortedReports,
	startTrialDaemon,
	TRIAL_FIXTURES,
	TRIAL_PROMPT,
	trialFixture,
	type TrialFixtureName
} from './trial-world.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PROXY = join(import.meta.dirname, 'proxy.ts');
const PLUGIN = join(ROOT, 'plugins', 'claude-code');
const SKILL = join(PLUGIN, 'skills', 'diff-delver', 'SKILL.md');
const SURFACE = join(ROOT, 'src', 'lib', 'server', 'mcp', 'fixtures', 'agent-surface.json');
/** The agent's own transcript, its reasoning between calls: for a developer to read, never committed. */
const TRANSCRIPTS = join(import.meta.dirname, 'transcripts');

/** The models the trials use, as each CLI names them. */
const MODELS = { claude: 'opus', codex: 'gpt-6.2-sol', scripted: 'none' } as const;

const DEFAULT_TIME_LIMIT_SECONDS = 600;
/** Claude Code's turns: far more than a medium diff needs, so only a loop reaches it. */
const CLAUDE_TURN_LIMIT = 120;

interface Options {
	readonly agent: AgentName;
	readonly fixture: TrialFixtureName;
	readonly skill: boolean;
	readonly timeLimitSeconds: number;
	/** The program to run as the agent's CLI, when not `claude` or `codex` found on the PATH. */
	readonly cli: string | undefined;
	/** The folder holding the CLI's login, when not the CLI's own. */
	readonly loginFrom: string | undefined;
	/** Where the recording and the transcript go, when not `recordings/` and `transcripts/`. */
	readonly out: string | undefined;
}

function parseOptions(argv: readonly string[]): Options {
	let agent: AgentName = 'scripted';
	let fixture: TrialFixtureName = 'shop';
	let skill = true;
	let timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS;
	let cli: string | undefined;
	let loginFrom: string | undefined;
	let out: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--agent' && next !== undefined) {
			const found = AGENTS.find((a) => a === next);
			if (found === undefined) throw new Error(`--agent is one of ${AGENTS.join(', ')}.`);
			agent = found;
			i += 1;
		} else if (arg === '--fixture' && next !== undefined) {
			const found = trialFixture(next);
			if (found === undefined) {
				throw new Error(`--fixture is one of ${Object.keys(TRIAL_FIXTURES).join(', ')}.`);
			}
			fixture = found;
			i += 1;
		} else if (arg === '--without-skill') {
			skill = false;
		} else if (arg === '--time-limit' && next !== undefined) {
			timeLimitSeconds = Number(next);
			if (!(timeLimitSeconds > 0)) throw new Error('--time-limit is a number of seconds.');
			i += 1;
		} else if (arg === '--cli' && next !== undefined) {
			cli = next;
			i += 1;
		} else if (arg === '--login-from' && next !== undefined) {
			loginFrom = next;
			i += 1;
		} else if (arg === '--out' && next !== undefined) {
			out = next;
			i += 1;
		} else {
			throw new Error(
				'Usage: pnpm trials:run [--agent claude|codex|scripted] [--fixture shop|ledger] [--without-skill] [--time-limit <seconds>]'
			);
		}
	}
	return { agent, fixture, skill, timeLimitSeconds, cli, loginFrom, out };
}

function sha256(path: string): string {
	return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** How long a short command, such as asking a CLI its version, may take. */
const SHORT_COMMAND_MS = 120_000;

/** Runs a short command, with no shell, and gives what it printed. */
async function capture(
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<{
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
	readonly error: string | null;
}> {
	return runBounded(command, args, {
		...options,
		limitMs: SHORT_COMMAND_MS,
		stop: stopping.signal
	});
}

/** Asks the CLI its version, which also proves it can be run at all. */
async function versionOf(cli: string, env: NodeJS.ProcessEnv): Promise<string> {
	const asked = await capture(cli, ['--version'], { env });
	if (asked.error !== null) {
		throw new Error(
			`Could not run ${cli} (${asked.error}). Install the CLI and log in to it, then run the trial again.`
		);
	}
	return asked.stdout.trim();
}

/** Where a program named without a folder is found on the PATH, as spawn would find it. */
function onPath(command: string, path: string): string {
	if (command.includes('/')) return command;
	for (const folder of path.split(delimiter)) {
		const candidate = join(folder, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here.
		}
	}
	return command;
}

interface AgentRun {
	readonly outcome: Recording['outcome'];
	readonly outcomeDetail: string | null;
	readonly cliVersion: string;
	readonly model: string;
	readonly session: Recording['session'];
	readonly finalMessage: string;
	readonly commands: readonly string[];
	readonly turns: number | null;
	readonly tokens: Recording['summary']['tokens'];
	/** The agent's own transcript, for the ignored folder. */
	readonly transcript: string;
}

interface Trial {
	readonly options: Options;
	/** The program run as the agent's CLI. */
	readonly cli: string;
	readonly root: string;
	readonly repository: string;
	readonly data: string;
	readonly home: string;
	readonly log: string;
	/** The MCP server the agent starts: the proxy in front of the real shim. */
	readonly server: { readonly command: string; readonly args: readonly string[] };
}

/** The environment an agent CLI runs with: nothing of the person's but `PATH`. */
function agentEnvironment(
	trial: Trial,
	extra: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
	const home = trial.home;
	return {
		PATH: process.env['PATH'] ?? '/usr/bin:/bin',
		HOME: home,
		USER: 'trial',
		LOGNAME: 'trial',
		LANG: 'C.UTF-8',
		TERM: 'dumb',
		TMPDIR: join(trial.root, 'tmp'),
		XDG_CONFIG_HOME: join(home, '.config'),
		XDG_DATA_HOME: join(home, '.local', 'share'),
		XDG_CACHE_HOME: join(home, '.cache'),
		XDG_STATE_HOME: join(home, '.local', 'state'),
		GIT_CONFIG_NOSYSTEM: '1',
		...extra
	};
}

/** Links the login in, kept where every way out of the harness takes it out again. */
function linkForTrial(real: string, link: string): LinkedLogin {
	const login = linkLogin(real, link);
	cleanUp.logins.push(login);
	return login;
}

/** Takes the login out now that the CLI has stopped, saying at once anything the person must know. */
function unlinkForTrial(login: LinkedLogin): void {
	const index = cleanUp.logins.indexOf(login);
	if (index >= 0) cleanUp.logins.splice(index, 1);
	for (const note of releaseLogin(login, new Date())) console.error(note);
}

// --- Claude Code -------------------------------------------------------------------

const ClaudeEvent = z
	.object({
		type: z.string(),
		subtype: z.string().optional(),
		model: z.string().optional(),
		tools: z.array(z.string()).optional(),
		mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
		plugins: z
			.array(z.object({ name: z.string(), source: z.string().optional() }).loose())
			.optional(),
		skills: z.array(z.union([z.string(), z.object({ name: z.string() }).loose()])).optional(),
		slash_commands: z.array(z.string()).optional(),
		memory_paths: z.unknown().optional(),
		claude_code_version: z.string().optional(),
		result: z.string().optional(),
		num_turns: z.number().optional(),
		is_error: z.boolean().optional(),
		usage: z
			.object({
				input_tokens: z.number().optional(),
				output_tokens: z.number().optional(),
				cache_read_input_tokens: z.number().optional(),
				cache_creation_input_tokens: z.number().optional()
			})
			.loose()
			.optional(),
		modelUsage: z.record(z.string(), z.unknown()).optional(),
		message: z
			.object({
				content: z.array(z.object({ type: z.string() }).loose()).optional()
			})
			.loose()
			.optional()
	})
	.loose();

const BashInput = z.object({ command: z.string() }).loose();
const NamedTool = z
	.object({ type: z.literal('tool_use'), name: z.string(), input: z.unknown() })
	.loose();

async function runClaude(trial: Trial): Promise<AgentRun> {
	const home = trial.home;
	const configDirectory = join(home, '.claude');
	const loginFolder =
		trial.options.loginFrom ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
	const credentials = join(loginFolder, '.credentials.json');
	checkLoginFresh('claude', credentials, Date.now());
	const login = linkForTrial(credentials, join(configDirectory, '.credentials.json'));
	const mcpConfig = join(trial.root, 'mcp.json');
	await writeFile(
		mcpConfig,
		JSON.stringify({
			mcpServers: { 'diff-delver': { command: trial.server.command, args: trial.server.args } }
		})
	);
	let plugin: string | undefined;
	if (trial.options.skill) {
		// The plugin as published, without its MCP configuration: the MCP server
		// comes from --mcp-config, behind the proxy.
		plugin = join(trial.root, 'plugin');
		await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
		await mkdir(join(plugin, 'skills', 'diff-delver'), { recursive: true });
		await copyFile(
			join(PLUGIN, '.claude-plugin', 'plugin.json'),
			join(plugin, '.claude-plugin', 'plugin.json')
		);
		await copyFile(SKILL, join(plugin, 'skills', 'diff-delver', 'SKILL.md'));
	}
	const env = agentEnvironment(trial, {
		CLAUDE_CONFIG_DIR: configDirectory,
		DISABLE_AUTOUPDATER: '1',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
	});
	const version = await versionOf(trial.cli, env);
	const started = Date.now();
	const run = await runBounded(
		trial.cli,
		claudeArguments({
			prompt: TRIAL_PROMPT,
			model: MODELS.claude,
			turnLimit: CLAUDE_TURN_LIMIT,
			repository: trial.repository,
			home,
			loginFolder,
			mcpConfig,
			plugin
		}),
		{
			cwd: trial.repository,
			env,
			limitMs: trial.options.timeLimitSeconds * 1000,
			stop: stopping.signal
		}
	);
	unlinkForTrial(login);

	const events = run.stdout
		.split('\n')
		.filter((line) => line.trim().startsWith('{'))
		.map((line) => ClaudeEvent.safeParse(JSON.parse(line)))
		.flatMap((parsed) => (parsed.success ? [parsed.data] : []));
	const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
	const result = events.findLast((e) => e.type === 'result');
	const commands: string[] = [];
	for (const event of events) {
		if (event.type !== 'assistant') continue;
		for (const block of event.message?.content ?? []) {
			const tool = NamedTool.safeParse(block);
			if (!tool.success || tool.data.name.startsWith('mcp__')) continue;
			const bash = BashInput.safeParse(tool.data.input);
			commands.push(
				bash.success && tool.data.name === 'Bash'
					? `Bash: ${bash.data.command}`
					: `${tool.data.name}: ${JSON.stringify(tool.data.input)}`
			);
		}
	}
	const models = Object.keys(result?.modelUsage ?? {});
	const usage = result?.usage;
	const turnLimited = result?.subtype === 'error_max_turns';
	const failed = result === undefined || result.is_error === true;
	return {
		outcome: run.timedOut
			? 'time-limit'
			: turnLimited
				? 'turn-limit'
				: failed
					? 'failed'
					: 'finished',
		outcomeDetail: run.timedOut
			? `Stopped after ${String(trial.options.timeLimitSeconds)} seconds.`
			: turnLimited
				? `Stopped after ${String(CLAUDE_TURN_LIMIT)} turns.`
				: failed
					? `claude ended with ${String(run.code)}: ${(result?.result ?? run.error ?? run.stderr).slice(0, 500)}`
					: null,
		cliVersion: version,
		model: models.join(', ') || (init?.model ?? MODELS.claude),
		session: {
			mcpServers: (init?.mcp_servers ?? []).map((s) => `${s.name} (${s.status})`),
			tools: init?.tools ?? [],
			skills: (init?.skills ?? []).map((s) => (typeof s === 'string' ? s : s.name)),
			plugins: (init?.plugins ?? []).map((p) => `${p.name} (${p.source ?? ''})`),
			instructions: init?.memory_paths === undefined ? [] : [JSON.stringify(init.memory_paths)]
		},
		finalMessage: result?.result ?? '',
		commands,
		turns: result?.num_turns ?? null,
		tokens:
			usage === undefined
				? null
				: {
						input: usage.input_tokens ?? 0,
						output: usage.output_tokens ?? 0,
						cacheRead: usage.cache_read_input_tokens ?? 0,
						cacheWrite: usage.cache_creation_input_tokens ?? 0
					},
		transcript: `${run.stdout}\n--- stderr ---\n${run.stderr}\n--- wall ${String(Date.now() - started)} ms`
	};
}

// --- Codex -----------------------------------------------------------------------------

const CodexEvent = z
	.object({
		type: z.string(),
		item: z
			.object({
				type: z.string(),
				command: z.string().optional(),
				text: z.string().optional(),
				server: z.string().optional(),
				tool: z.string().optional()
			})
			.loose()
			.optional(),
		usage: z
			.object({
				input_tokens: z.number().optional(),
				cached_input_tokens: z.number().optional(),
				output_tokens: z.number().optional()
			})
			.loose()
			.optional()
	})
	.loose();

async function runCodex(trial: Trial): Promise<AgentRun> {
	const codexHome = join(trial.home, '.codex');
	const loginFolder =
		trial.options.loginFrom ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
	const credentials = join(loginFolder, 'auth.json');
	checkLoginFresh('codex', credentials, Date.now());
	const login = linkForTrial(credentials, join(codexHome, 'auth.json'));
	if (trial.options.skill) {
		await mkdir(join(codexHome, 'skills', 'diff-delver'), { recursive: true });
		await copyFile(SKILL, join(codexHome, 'skills', 'diff-delver', 'SKILL.md'));
	}
	const env = agentEnvironment(trial, { CODEX_HOME: codexHome });
	const version = await versionOf(trial.cli, env);
	await writeFile(
		join(codexHome, 'config.toml'),
		codexConfig({
			model: MODELS.codex,
			repository: trial.repository,
			installation: installationOf(onPath(trial.cli, env['PATH'] ?? '')),
			skills: join(codexHome, 'skills'),
			server: trial.server
		})
	);
	const servers = await capture(trial.cli, ['mcp', 'list', '--json'], { env });
	// What the model will be shown, rendered by codex itself without calling the
	// model: the evidence of which skills and instructions the session has.
	const shown = await capture(trial.cli, ['debug', 'prompt-input', 'start'], {
		cwd: trial.repository,
		env
	});
	const skillsShown = [...shown.stdout.matchAll(/\\n- ([a-z0-9-]+): .*?\(file: ([^)]*)\)/g)].map(
		(m) => `${m[1] ?? ''} (${m[2] ?? ''})`
	);
	const toolsShown = [
		...new Set([...shown.stdout.matchAll(/"name":\s*"([A-Za-z0-9_.-]+)"/g)].map((m) => m[1] ?? ''))
	];
	const agentsFiles = [...shown.stdout.matchAll(/AGENTS\.md instructions for ([^\\]*)/g)].map(
		(m) => m[1] ?? ''
	);
	const lastMessage = join(trial.root, 'last-message.txt');
	const started = Date.now();
	const run = await runBounded(
		trial.cli,
		codexArguments({
			prompt: TRIAL_PROMPT,
			model: MODELS.codex,
			repository: trial.repository,
			lastMessage
		}),
		{
			cwd: trial.repository,
			env,
			limitMs: trial.options.timeLimitSeconds * 1000,
			stop: stopping.signal
		}
	);
	unlinkForTrial(login);
	const events = run.stdout
		.split('\n')
		.filter((line) => line.trim().startsWith('{'))
		.map((line) => CodexEvent.safeParse(JSON.parse(line)))
		.flatMap((parsed) => (parsed.success ? [parsed.data] : []));
	const commands = events
		.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution')
		.map((e) => `shell: ${e.item?.command ?? ''}`);
	const usages = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage);
	const finalMessage = existsSync(lastMessage) ? await readFile(lastMessage, 'utf8') : '';
	const failed =
		run.code !== 0 || events.some((e) => e.type === 'turn.failed' || e.type === 'error');
	const serverNames = z
		.array(z.object({ name: z.string() }).loose())
		.safeParse(JSON.parse(servers.stdout.trim() === '' ? '[]' : servers.stdout));
	return {
		outcome: run.timedOut ? 'time-limit' : failed ? 'failed' : 'finished',
		outcomeDetail: run.timedOut
			? `Stopped after ${String(trial.options.timeLimitSeconds)} seconds.`
			: failed
				? `codex ended with ${String(run.code)}: ${(run.error ?? run.stderr).slice(-500)}`
				: null,
		cliVersion: version,
		model: MODELS.codex,
		session: {
			mcpServers: serverNames.success ? serverNames.data.map((s) => s.name) : [servers.stdout],
			tools: toolsShown,
			skills: skillsShown,
			plugins: [],
			instructions: agentsFiles
		},
		finalMessage: finalMessage.trim(),
		commands,
		turns: usages.length,
		tokens:
			usages.length === 0
				? null
				: {
						input: usages.reduce((n, u) => n + (u?.input_tokens ?? 0), 0),
						output: usages.reduce((n, u) => n + (u?.output_tokens ?? 0), 0),
						cacheRead: usages.reduce((n, u) => n + (u?.cached_input_tokens ?? 0), 0),
						cacheWrite: 0
					},
		transcript: `${run.stdout}\n--- stderr ---\n${run.stderr}\n--- wall ${String(Date.now() - started)} ms`
	};
}

// --- The stand-in --------------------------------------------------------------------

/** The scripted categorisation, through the same proxy and shim an agent would start. */
async function runScripted(trial: Trial): Promise<AgentRun> {
	const transport = new StdioClientTransport({
		command: trial.server.command,
		args: [...trial.server.args],
		cwd: trial.repository,
		env: { PATH: process.env['PATH'] ?? '', HOME: trial.home },
		stderr: 'pipe'
	});
	const client = new Client({ name: 'diff-delver-trial-stand-in', version: '1.0.0' });
	await client.connect(transport);
	const Result = z.object({
		content: z.array(z.object({ text: z.string() }).loose()),
		isError: z.boolean().optional()
	});
	const session: McpSession = {
		client,
		stderr: () => '',
		async call(name, args = {}) {
			const result = Result.parse(await client.callTool({ name, arguments: { ...args } }));
			return {
				text: result.content.map((c) => c.text).join('\n'),
				refused: result.isError === true
			};
		},
		close: () => client.close()
	};
	const closeOnStop = (): void => void client.close();
	stopping.signal.addEventListener('abort', closeOnStop, { once: true });
	let outcome: Recording['outcome'] = 'finished';
	let detail: string | null = null;
	try {
		if (trial.options.fixture === 'shop') {
			await categoriseShop(session);
		} else {
			// One section for everything: enough to exercise the harness on a larger diff.
			const created = await session.call('create_report', {});
			const report = /Report (r_[0-9a-z]+)/.exec(created.text)?.[1] ?? '';
			const manifest = await session.call('get_manifest', { report });
			const version = Number(/, version (\d+)\./.exec(manifest.text)?.[1] ?? '1');
			await session.call('upsert_sections', {
				report,
				version,
				sections: [{ id: 'everything', title: 'Everything', summary: 'All of it.' }]
			});
			await session.call('assign', {
				report,
				version,
				items: [{ glob: '**', section: 'everything' }]
			});
			await session.call('get_coverage', { report });
		}
	} catch (error) {
		outcome = 'failed';
		detail = error instanceof Error ? error.message : String(error);
	} finally {
		stopping.signal.removeEventListener('abort', closeOnStop);
		await session.close();
	}
	return {
		outcome,
		outcomeDetail: detail,
		cliVersion: 'scripted',
		model: MODELS.scripted,
		session: { mcpServers: ['diff-delver'], tools: [], skills: [], plugins: [], instructions: [] },
		finalMessage: 'The scripted categorisation finished.',
		commands: [],
		turns: null,
		tokens: null,
		transcript: ''
	};
}

// --- The trial -------------------------------------------------------------------------

/** Every line of the repository's files before and after, trimmed, to find code pasted into prose. */
async function codeLinesOf(repository: string): Promise<ReadonlySet<string>> {
	const files = (
		await capture('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
			cwd: repository
		})
	).stdout
		.split('\n')
		.filter((f) => f !== '');
	const lines = new Set<string>();
	const add = (text: string): void => {
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length > 0) lines.add(trimmed);
		}
	};
	for (const file of files) {
		const now = await readFile(join(repository, file), 'utf8').catch(() => '');
		add(now);
		add((await capture('git', ['show', `HEAD:${file}`], { cwd: repository })).stdout);
	}
	return lines;
}

/** What every way out of the harness must undo, kept where a signal or the exit can reach it. */
const cleanUp: { logins: LinkedLogin[]; root: string | undefined } = {
	logins: [],
	root: undefined
};

/**
 * Undoes everything at once, synchronously, so it can run as the process
 * exits: stops every program the harness started and what they started, takes
 * the login out, and removes the temporary folder. Doing it twice does nothing.
 */
function cleanUpNow(): void {
	killEveryGroup();
	for (const login of cleanUp.logins.splice(0)) {
		for (const note of releaseLogin(login, new Date())) console.error(note);
	}
	if (cleanUp.root !== undefined) {
		rmSync(cleanUp.root, { recursive: true, force: true });
		cleanUp.root = undefined;
	}
}

/** Aborted when the person asks the harness to stop: every program it runs is then stopped. */
const stopping = new AbortController();

/** A trial stopped by the person: it records nothing. */
class TrialStopped extends Error {}

function stopIfAsked(): void {
	if (stopping.signal.aborted) {
		throw new TrialStopped(`Stopped (${String(stopping.signal.reason)}): nothing was recorded.`);
	}
}

const EXIT_CODES: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.on(signal, () => {
		if (stopping.signal.aborted) {
			// Asked twice: stop now.
			cleanUpNow();
			process.exit(EXIT_CODES[signal] ?? 1);
		}
		console.error(`${signal}: stopping the trial and cleaning up.`);
		stopping.abort(signal);
	});
}
process.on('exit', cleanUpNow);

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	ensureBuild();
	const root = await mkdtemp(join(tmpdir(), 'diff-delver-trial-'));
	cleanUp.root = root;
	const repository = join(root, 'work', options.fixture);
	const data = join(root, 'data');
	const home = join(root, 'home');
	const log = join(root, 'proxy.jsonl');
	await mkdir(join(root, 'tmp'), { recursive: true });
	await mkdir(home, { recursive: true });
	const reviewerHome = join(root, 'reviewer');
	await mkdir(join(reviewerHome, 'xdg'), { recursive: true });
	await writeFile(join(reviewerHome, 'gitconfig'), '');
	const gitEnv = {
		HOME: reviewerHome,
		XDG_CONFIG_HOME: join(reviewerHome, 'xdg'),
		GIT_CONFIG_GLOBAL: join(reviewerHome, 'gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1'
	};
	const trial: Trial = {
		options,
		cli: options.cli ?? options.agent,
		root,
		repository,
		data,
		home,
		log,
		server: {
			command: process.execPath,
			args: [
				PROXY,
				'--log',
				log,
				'--',
				process.execPath,
				BUILT_COMMAND,
				'mcp',
				'--no-open',
				'--data-directory',
				data
			]
		}
	};
	console.log(
		`Trial: ${options.agent} on ${options.fixture}${options.skill ? '' : ', without the skill'}, in ${root}`
	);
	try {
		await TRIAL_FIXTURES[options.fixture].build(await GitRepo.init(absolutePath(repository)));
		const codeLines = await codeLinesOf(repository);
		stopIfAsked();
		const daemon = await startTrialDaemon(absolutePath(data), { gitEnv });
		const before = await listDirectory(repository);
		const started = Date.now();
		let run: AgentRun;
		try {
			switch (options.agent) {
				case 'claude':
					run = await runClaude(trial);
					break;
				case 'codex':
					run = await runCodex(trial);
					break;
				case 'scripted':
					run = await runScripted(trial);
					break;
			}
		} finally {
			// The CLI has stopped; take the login out before anything else can fail.
			for (const login of cleanUp.logins.splice(0)) unlinkForTrial(login);
			await daemon.stop();
		}
		stopIfAsked();
		const wallSeconds = Math.round((Date.now() - started) / 1000);
		const after = await listDirectory(repository);
		const changed = [
			...after.filter((line) => !before.includes(line)).map((line) => `now ${line}`),
			...before.filter((line) => !after.includes(line)).map((line) => `was ${line}`)
		];
		const proxyLog = existsSync(log)
			? readProxyLog(await readFile(log, 'utf8'))
			: { messages: [], calls: [] };
		const finalState = await sortedReports(absolutePath(data), { gitEnv });
		const last = finalState.at(-1);
		const callsByTool: Record<string, number> = {};
		for (const call of proxyLog.calls) callsByTool[call.tool] = (callsByTool[call.tool] ?? 0) + 1;
		const raw: Recording = {
			format: 1,
			fixture: options.fixture,
			agent: { cli: options.agent, cliVersion: run.cliVersion, model: run.model },
			recordedOn: new Date().toISOString().slice(0, 10),
			prompt: TRIAL_PROMPT,
			skill: options.skill,
			hashes: { agentSurface: sha256(SURFACE), skill: sha256(SKILL) },
			bounds: {
				timeLimitSeconds: options.timeLimitSeconds,
				turnLimit: options.agent === 'claude' ? CLAUDE_TURN_LIMIT : null
			},
			outcome: run.outcome,
			outcomeDetail: run.outcomeDetail,
			session: run.session,
			messages: proxyLog.messages,
			calls: proxyLog.calls,
			finalMessage: run.finalMessage,
			finalState,
			summary: {
				fullCoverage:
					last !== undefined && last.placements.every((p) => !p.includes(' not-sorted ')),
				sections: last?.sections.length ?? 0,
				callsByTool,
				refusals: proxyLog.calls.flatMap((call, i) =>
					call.answer?.refused === true
						? [{ call: i + 1, tool: call.tool, text: call.answer.text }]
						: []
				),
				forbidden: [...forbiddenIn(proxyLog.calls, codeLines, changed)],
				commands: [...run.commands],
				wallSeconds,
				turns: run.turns,
				tokens: run.tokens
			}
		};
		const normalise = normaliser({
			repository,
			data,
			trial: root,
			home: homedir(),
			user: userInfo().username
		});
		const recording = RecordingSchema.parse(normaliseDeep(raw, normalise));
		const recordings = options.out ?? RECORDINGS_DIRECTORY;
		const transcripts = options.out ?? TRANSCRIPTS;
		await mkdir(recordings, { recursive: true });
		const name = recordingName(options.fixture, options.agent, options.skill);
		const path = join(recordings, name);
		await writeFile(path, `${JSON.stringify(recording, null, '\t')}\n`);
		// In the form pnpm verify's format check wants, so it can be committed as written.
		await capture(join(ROOT, 'node_modules', '.bin', 'prettier'), ['--write', path]);
		await mkdir(transcripts, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const transcript = join(transcripts, `${name.replace(/\.json$/, '')}.${stamp}.txt`);
		await writeFile(transcript, normalise(run.transcript));
		const s = recording.summary;
		console.log(
			[
				`Outcome: ${recording.outcome}${recording.outcomeDetail === null ? '' : ` (${recording.outcomeDetail})`}`,
				`Coverage reached: ${s.fullCoverage ? 'yes' : 'no'}; sections: ${String(s.sections)}; calls: ${String(recording.calls.length)} ${JSON.stringify(s.callsByTool)}`,
				`Refused: ${String(s.refusals.length)}; forbidden: ${String(s.forbidden.length)}; commands: ${String(s.commands.length)}`,
				`Time: ${String(s.wallSeconds)} s; turns: ${String(s.turns)}; tokens: ${JSON.stringify(s.tokens)}`,
				`Session: ${JSON.stringify(recording.session)}`,
				`Recording: ${path}`,
				`Transcript (not committed): ${transcript}`
			].join('\n')
		);
	} finally {
		cleanUpNow();
	}
}

try {
	await main();
} catch (error) {
	cleanUpNow();
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode =
		error instanceof TrialStopped ? (EXIT_CODES[String(stopping.signal.reason)] ?? 1) : 1;
}
