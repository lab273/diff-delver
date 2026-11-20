/**
 * When `pnpm bd push` tries again, and what it says when it gives up
 * (scripts/bd-push.ts). The push is a scripted function here; the real one is
 * run against a throwaway database in scripts/bd.test.ts.
 */
import { attemptCountOf } from '../src/lib/core/attempt-count.tiny.ts';
import { fieldPath } from '../src/lib/core/field-path.tiny.ts';
import { issueLocation } from '../src/lib/core/issue-location.tiny.ts';
import { millisecondsOf } from '../src/lib/core/milliseconds.tiny.ts';
import { shownText } from '../src/lib/core/shown-text.tiny.ts';
import { describe, expect, it } from 'vitest';
import { parseExitCode, type ExitCode } from '../src/lib/core/exit-code.tiny.ts';
import {
	commandLine,
	describePushProblem,
	planCommand,
	isNetworkTimeout,
	pushWithRetries,
	type PushAttempt
} from './bd-push.ts';

function code(n: number): ExitCode {
	const parsed = parseExitCode(n);
	if (!parsed.ok) throw new Error(`bad exit code ${String(n)}`);
	return parsed.value;
}

/** A push that gives these results in turn, and records the waits between them. */
function scripted(results: readonly PushAttempt[]): {
	attempt: () => Promise<PushAttempt>;
	waits: number[];
	notices: string[];
	tries: () => number;
} {
	let n = 0;
	const waits: number[] = [];
	const notices: string[] = [];
	return {
		attempt: () => {
			const result = results[Math.min(n, results.length - 1)];
			n += 1;
			if (result === undefined) throw new Error('no scripted result');
			return Promise.resolve(result);
		},
		waits,
		notices,
		tries: () => n
	};
}

const TIMEOUT: PushAttempt = {
	code: code(1),
	output:
		'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.'
};
const DONE: PushAttempt = { code: code(0), output: 'Push complete.' };

describe('isNetworkTimeout', () => {
	it.each([
		'ssh: connect to host github.com port 22: Connection timed out',
		'Operation timed out',
		'error: i/o timeout',
		'context deadline exceeded',
		'kex_exchange_identification: read: Connection reset by peer',
		'fatal: unable to access: Failed to connect: Timeout was reached'
	])('counts "%s"', (output) => {
		expect(isNetworkTimeout(output)).toBe(true);
	});

	it.each([
		'Permission denied (publickey).',
		'error: failed to push some refs: non-fast-forward',
		'Repository not found.'
	])('does not count "%s"', (output) => {
		expect(isNetworkTimeout(output)).toBe(false);
	});
});

describe('pushWithRetries', () => {
	const wait = (into: number[]) => (ms: number) => {
		into.push(ms);
		return Promise.resolve();
	};

	it('pushes once when the first try works', async () => {
		const push = scripted([DONE]);
		const result = await pushWithRetries(push.attempt, wait(push.waits), (t) =>
			push.notices.push(t)
		);
		expect(result).toEqual({ ok: true, value: 1 });
		expect(push.waits).toEqual([]);
		expect(push.notices).toEqual([]);
	});

	it('tries again after a timeout, waiting longer each time, and says so', async () => {
		const push = scripted([TIMEOUT, TIMEOUT, DONE]);
		const result = await pushWithRetries(
			push.attempt,
			wait(push.waits),
			(t) => push.notices.push(t),
			[10, 20, 30].map(millisecondsOf)
		);
		expect(result).toEqual({ ok: true, value: 3 });
		expect(push.waits).toEqual([10, 20]);
		expect(push.notices).toEqual([
			'The push timed out (try 1 of 4). Trying again in 0.01 s.',
			'The push timed out (try 2 of 4). Trying again in 0.02 s.'
		]);
	});

	it('gives up after the last delay when every try times out', async () => {
		const push = scripted([TIMEOUT]);
		const result = await pushWithRetries(
			push.attempt,
			wait(push.waits),
			() => undefined,
			[1, 2].map(millisecondsOf)
		);
		expect(result).toEqual({ ok: false, error: { kind: 'PushTimedOut', attempts: 3 } });
		expect(push.tries()).toBe(3);
	});

	it('does not try again after a failure that is not a timeout', async () => {
		const push = scripted([{ code: code(128), output: 'Permission denied (publickey).' }]);
		const result = await pushWithRetries(
			push.attempt,
			wait(push.waits),
			() => undefined,
			[1, 2].map(millisecondsOf)
		);
		expect(result).toEqual({ ok: false, error: { kind: 'PushFailed', code: 128, attempts: 1 } });
		expect(push.tries()).toBe(1);
	});
});

describe('planCommand', () => {
	it('checks, then pushes with retries, for push and dolt push', () => {
		expect(planCommand(['push'])).toEqual({ kind: 'Push', extra: [], anyway: false });
		expect(planCommand(['dolt', 'push', '--remote', 'x'])).toEqual({
			kind: 'Push',
			extra: ['--remote', 'x'],
			anyway: false
		});
	});

	it('checks first for any command with push or sync among its arguments', () => {
		for (const args of [['-C', '.', 'dolt', 'push'], ['sync'], ['federation', 'sync']]) {
			expect(planCommand(args)).toEqual({ kind: 'CheckThenRun', args, anyway: false });
		}
	});

	it('passes everything else straight through', () => {
		expect(planCommand(['create', 'push the fix'])).toEqual({
			kind: 'PassThrough',
			args: ['create', 'push the fix']
		});
		expect(planCommand([])).toEqual({ kind: 'PassThrough', args: [] });
	});

	it('takes --anyway out wherever it is, and never passes it to bd', () => {
		expect(planCommand(['push', '--anyway'])).toEqual({ kind: 'Push', extra: [], anyway: true });
		expect(planCommand(['--anyway', 'sync'])).toEqual({
			kind: 'CheckThenRun',
			args: ['sync'],
			anyway: true
		});
	});
});

describe('commandLine', () => {
	it('gives the command as it can be typed again', () => {
		expect(commandLine(['push', '--anyway'])).toBe('pnpm bd push --anyway');
		expect(commandLine(['-C', 'my dir', 'sync', "it's"])).toBe(
			"pnpm bd -C 'my dir' sync 'it'\\''s'"
		);
	});
});

describe('describePushProblem', () => {
	it('lists every finding, says nothing was pushed, and how to push anyway', () => {
		const text = describePushProblem({
			kind: 'FoundPrivateData',
			findings: [
				{
					issue: issueLocation('dd-1'),
					field: fieldPath('notes'),
					kind: 'Email',
					shown: shownText('a@example.com')
				}
			],
			anyway: 'pnpm bd push --anyway'
		});
		expect(text).toContain('Nothing was pushed');
		expect(text).toContain(
			'dd-1 notes: an email address that is not on the allow-list: a@example.com'
		);
		expect(text).toContain('tell the project owner');
		expect(text).toContain('push\nanyway with: pnpm bd push --anyway');
	});

	it.each([
		[{ kind: 'BdNotFound' }, 'Install beads'],
		[{ kind: 'ExportFailed', code: code(2) }, 'nothing was pushed'],
		[{ kind: 'PushFailed', code: code(1), attempts: attemptCountOf(1) }, 'run pnpm bd push again'],
		[{ kind: 'PushTimedOut', attempts: attemptCountOf(4) }, 'timed out 4 times']
	] as const)('says what happened and what to do for %o', (problem, words) => {
		expect(describePushProblem(problem)).toContain(words);
	});
});
