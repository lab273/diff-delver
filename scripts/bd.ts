/**
 * `pnpm bd <bd arguments>`: runs beads' `bd` with the agent identity always
 * set, so no personal name or email address is copied into an issue (docs/DEVELOPING.md,
 * "Tracking work"). Arguments, output and exit status pass through unchanged.
 *
 * A publishing command, `pnpm bd push`, `pnpm bd dolt push` or `pnpm bd sync`
 * (scripts/bd-push.ts, `planCommand`), checks the issue data first: it exports
 * every record, scans it for what looks personal or sensitive
 * (scripts/private-data-scan.ts), and stops if anything is found, unless the
 * command is given again with `--anyway`. It is a helper for honest mistakes, not
 * a guarantee: it reads only the current data, and anything else passes straight
 * through. A push that times out on the network is tried again a few times.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AttemptCount } from '../src/lib/core/attempt-count.tiny.ts';
import { parseExitCode, type ExitCode } from '../src/lib/core/exit-code.tiny.ts';
import { err, ok, type Result } from '../src/lib/core/result.ts';
import {
	AGENT_ACTOR,
	AGENT_EMAIL,
	ALLOWED_EMAILS,
	PRIVATE_TERMS_FILE
} from './issue-tracker-identity.ts';
import {
	ANYWAY,
	commandLine,
	describePushProblem,
	planCommand,
	pushWithRetries,
	type PushAttempt,
	type PushProblem
} from './bd-push.ts';
import { describeFinding, parsePrivateTerms, scanExport } from './private-data-scan.ts';

/** The environment every bd command runs with. */
function bdEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		BEADS_ACTOR: AGENT_ACTOR,
		GIT_AUTHOR_EMAIL: AGENT_EMAIL,
		// beads' anonymous usage metrics stay off (docs/DEVELOPING.md, "Tracking work").
		DO_NOT_TRACK: '1'
	};
}

const FAILED = exitCode(1);

function exitCode(value: number): ExitCode {
	const parsed = parseExitCode(value);
	if (!parsed.ok) throw new RangeError(`Not an exit status: ${String(value)}`);
	return parsed.value;
}

/** An exit status for how a child process ended, as a shell would give it. */
function statusOf(code: number | null, signal: NodeJS.Signals | null): ExitCode {
	if (code !== null) return exitCode(code);
	if (signal !== null) return exitCode(128 + constants.signals[signal]);
	return FAILED;
}

type Output = 'inherit' | 'capture';

interface Ran {
	readonly code: ExitCode;
	/** What it printed, when captured. Still shown to the person as it runs. */
	readonly output: string;
}

/** Runs bd with the agent identity. Fails only when bd cannot be started. */
function runBd(args: readonly string[], output: Output): Promise<Result<Ran, PushProblem>> {
	return new Promise((resolve) => {
		const child = spawn('bd', args, {
			stdio: output === 'inherit' ? 'inherit' : ['inherit', 'pipe', 'pipe'],
			env: bdEnvironment()
		});
		const chunks: string[] = [];
		child.stdout?.on('data', (chunk: Buffer) => {
			process.stdout.write(chunk);
			chunks.push(chunk.toString('utf8'));
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			process.stderr.write(chunk);
			chunks.push(chunk.toString('utf8'));
		});
		child.on('error', () => {
			resolve(err({ kind: 'BdNotFound' }));
		});
		child.on('close', (code, signal) => {
			resolve(ok({ code: statusOf(code, signal), output: chunks.join('') }));
		});
	});
}

async function readPrivateTerms(): Promise<readonly string[]> {
	try {
		return parsePrivateTerms(await readFile(PRIVATE_TERMS_FILE, 'utf8'));
	} catch {
		// No file: no private terms beyond the built-in checks.
		return [];
	}
}

/**
 * Exports the issue data and scans it. Gives a problem if something is found,
 * unless `anyway`, when it lists what was found and carries on. `again` is the
 * command to give with --anyway.
 */
async function check(
	anyway: boolean,
	again: readonly string[]
): Promise<Result<void, PushProblem>> {
	const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-issues-'));
	try {
		const file = join(scratch, 'issues.jsonl');
		const exported = await runBd(['export', '--all', '-o', file], 'capture');
		if (!exported.ok) return exported;
		if (exported.value.code !== 0) return err({ kind: 'ExportFailed', code: exported.value.code });

		const findings = scanExport(await readFile(file, 'utf8'), {
			allowedEmails: ALLOWED_EMAILS,
			privateTerms: await readPrivateTerms()
		});
		if (findings.length === 0) {
			console.log('Checked the issue data: nothing personal or sensitive found.');
			return ok(undefined);
		}
		if (!anyway) {
			return err({ kind: 'FoundPrivateData', findings, anyway: commandLine([...again, ANYWAY]) });
		}
		console.error(
			[
				`Going ahead with --anyway, although the issue data holds ${String(findings.length)} ` +
					'thing(s) that look personal or sensitive:',
				...findings.map((finding) => `  ${describeFinding(finding)}`)
			].join('\n')
		);
		return ok(undefined);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Pushes with `bd dolt push`, `extra` going to it, trying again after a timeout. */
async function push(extra: readonly string[]): Promise<Result<AttemptCount, PushProblem>> {
	const attempt = async (): Promise<PushAttempt> => {
		const ran = await runBd(['dolt', 'push', ...extra], 'capture');
		// bd ran for the export a moment ago, so it can only be gone if it was removed since.
		return ran.ok ? ran.value : { code: exitCode(127), output: '' };
	};
	return pushWithRetries(
		attempt,
		(ms) => sleep(ms),
		(text) => {
			console.error(text);
		}
	);
}

async function passThrough(args: readonly string[]): Promise<ExitCode> {
	const ran = await runBd(args, 'inherit');
	if (ran.ok) return ran.value.code;
	console.error(describePushProblem(ran.error));
	return exitCode(127);
}

async function main(given: readonly string[]): Promise<ExitCode> {
	const plan = planCommand(given);
	switch (plan.kind) {
		case 'PassThrough':
			return passThrough(plan.args);
		case 'Push':
		case 'CheckThenRun': {
			const again = given.filter((arg) => arg !== ANYWAY);
			const checked = await check(plan.anyway, again);
			if (!checked.ok) {
				console.error(`\n${describePushProblem(checked.error)}`);
				return FAILED;
			}
			if (plan.kind === 'CheckThenRun') return passThrough(plan.args);
			const pushed = await push(plan.extra);
			if (pushed.ok) return exitCode(0);
			console.error(`\n${describePushProblem(pushed.error)}`);
			return FAILED;
		}
		default: {
			const unknown: never = plan;
			return unknown;
		}
	}
}

process.exitCode = await main(process.argv.slice(2));
