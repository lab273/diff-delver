/**
 * The decisions behind `pnpm bd push`, kept apart from running anything so
 * they can be tested: which commands are checked first, which push failures are
 * worth another try, how long to wait between tries, and what to tell the person
 * when it does not work.
 */
import type { ExitCode } from '../src/lib/core/exit-code.tiny.ts';
import { err, ok, type Result } from '../src/lib/core/result.ts';
import { describeFinding, type Finding } from './private-data-scan.ts';

/** Added to a command to push even though the check found something. Never passed to bd. */
export const ANYWAY = '--anyway';

/** What `pnpm bd` does with its arguments. */
export type Plan =
	/** Runs bd with the arguments, unchanged. */
	| { readonly kind: 'PassThrough'; readonly args: readonly string[] }
	/** `push` or `dolt push`: checks, then runs `bd dolt push` with `extra`, retrying a timeout. */
	| { readonly kind: 'Push'; readonly extra: readonly string[]; readonly anyway: boolean }
	/** Another command that may publish, such as `sync`: checks, then runs bd with the arguments. */
	| { readonly kind: 'CheckThenRun'; readonly args: readonly string[]; readonly anyway: boolean };

/** Words that may mean the command publishes the issue data. */
const PUBLISHING_WORDS: readonly string[] = ['push', 'sync'];

/**
 * Best effort, not a parse of bd's grammar: any command with `push` or `sync` as
 * one of its arguments is checked first, so `bd -C . dolt push` and `bd sync` are
 * too. `--anyway` is taken out wherever it is.
 */
export function planCommand(given: readonly string[]): Plan {
	const anyway = given.includes(ANYWAY);
	const args = given.filter((arg) => arg !== ANYWAY);
	if (args[0] === 'push') return { kind: 'Push', extra: args.slice(1), anyway };
	if (args[0] === 'dolt' && args[1] === 'push')
		return { kind: 'Push', extra: args.slice(2), anyway };
	if (args.some((arg) => PUBLISHING_WORDS.includes(arg)))
		return { kind: 'CheckThenRun', args, anyway };
	return { kind: 'PassThrough', args };
}

/** A command as a person would type it again, with arguments quoted for a shell where needed. */
export function commandLine(args: readonly string[]): string {
	const quoted = args.map((arg) =>
		/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
	);
	return ['pnpm', 'bd', ...quoted].join(' ');
}

/** What one run of `bd dolt push` did: its exit status and everything it printed. */
export interface PushAttempt {
	readonly code: ExitCode;
	readonly output: string;
}

/**
 * The waits before the second, third and fourth tries. The SSH connection to the
 * remote is intermittently slow, so a timeout is usually gone on the next try.
 */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

/**
 * Whether a failed push failed because the network timed out, as git, ssh and
 * Dolt say it, rather than for a reason another try would not change.
 */
export function isNetworkTimeout(output: string): boolean {
	return /timed? ?out|timeout|deadline exceeded|kex_exchange_identification/i.test(output);
}

/** Why a push did not happen. Every one has a message, in `describePushProblem`. */
export type PushProblem =
	| { readonly kind: 'BdNotFound' }
	| { readonly kind: 'ExportFailed'; readonly code: ExitCode }
	| {
			readonly kind: 'FoundPrivateData';
			readonly findings: readonly Finding[];
			/** The command again, with --anyway, to push regardless. */
			readonly anyway: string;
	  }
	| { readonly kind: 'PushFailed'; readonly code: ExitCode; readonly attempts: number }
	| { readonly kind: 'PushTimedOut'; readonly attempts: number };

/** What happened and what to do next, for the person who ran the push. */
export function describePushProblem(problem: PushProblem): string {
	switch (problem.kind) {
		case 'BdNotFound':
			return (
				'Could not run bd, the beads command. Install beads (https://beads.gascity.com/) ' +
				'so that bd is on your PATH, then try again.'
			);
		case 'ExportFailed':
			return (
				`bd export failed (exit status ${String(problem.code)}), so the issue data could not be ` +
				'checked and nothing was pushed. Its message is above; fix that and try again.'
			);
		case 'FoundPrivateData':
			return [
				`Nothing was pushed: the issue data holds ${String(problem.findings.length)} thing(s) that ` +
					'look personal or sensitive (README, "Tracking work"):',
				...problem.findings.map((finding) => `  ${describeFinding(finding)}`),
				'If one is personal, edit the issue to remove it, and tell the project owner before',
				'anything is pushed: beads publishes every earlier version of an issue too, so an edit',
				'does not take it out of what would be published. If they are all false alarms, push',
				`anyway with: ${problem.anyway}`
			].join('\n');
		case 'PushFailed':
			return (
				`bd dolt push failed (exit status ${String(problem.code)}) after ${String(problem.attempts)} ` +
				'try or tries. Its message is above. The issue data passed the check, so once that is ' +
				'fixed, run pnpm bd push again.'
			);
		case 'PushTimedOut':
			return (
				`bd dolt push timed out ${String(problem.attempts)} times in a row. The remote may be ` +
				'unreachable or very slow; check your network and SSH access to it, then run ' +
				'pnpm bd push again.'
			);
		default: {
			const unknown: never = problem;
			return unknown;
		}
	}
}

/**
 * Runs `attempt` until it succeeds, retrying only a network timeout, waiting the
 * given delays between tries. Gives the number of tries it took.
 */
export async function pushWithRetries(
	attempt: () => Promise<PushAttempt>,
	wait: (ms: number) => Promise<void>,
	notice: (text: string) => void,
	delays: readonly number[] = RETRY_DELAYS_MS
): Promise<Result<number, PushProblem>> {
	const tries = delays.length + 1;
	for (let n = 1; ; n += 1) {
		const result = await attempt();
		if (result.code === 0) return ok(n);
		const timedOut = isNetworkTimeout(result.output);
		const delay = delays[n - 1];
		if (!timedOut) return err({ kind: 'PushFailed', code: result.code, attempts: n });
		if (delay === undefined) return err({ kind: 'PushTimedOut', attempts: n });
		notice(
			`The push timed out (try ${String(n)} of ${String(tries)}). ` +
				`Trying again in ${String(delay / 1000)} s.`
		);
		await wait(delay);
	}
}
