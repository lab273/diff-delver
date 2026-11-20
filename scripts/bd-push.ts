/**
 * The decisions behind `pnpm bd push`, kept apart from running anything so
 * they can be tested: which push failures are worth another try, how long to wait
 * between tries, and what to tell the person when it does not work.
 */
import type { ExitCode } from '../src/lib/core/exit-code.tiny.ts';
import { err, ok, type Result } from '../src/lib/core/result.ts';
import { describeFinding, type Finding } from './private-data-scan.ts';

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
	| { readonly kind: 'FoundPrivateData'; readonly findings: readonly Finding[] }
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
					'must not be published (README, "Tracking work").',
				...problem.findings.map((finding) => `  ${describeFinding(finding)}`),
				'Each one is still only on this machine. Edit those issues to remove it, then push again.',
				'Beads keeps every earlier version of an issue and pushes that history too, so an edit',
				'alone does not remove it from what would be published: tell the project owner, because',
				'removing it means rebuilding the database before anything is pushed.'
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
