import { mkdir } from 'node:fs/promises';
import { parseExitCode, type ExitCode } from '#lib/core/exit-code.tiny.ts';
import { gitStderr } from '#lib/core/git-stderr.tiny.ts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutePath } from '../../../../tests/support/git-repo.ts';
import { emptyRepo } from '../../../../tests/support/fixture-repos.ts';
import { describeGitError, runGit, runGitText, type GitError } from './run-git.ts';

function exitCode(value: number): ExitCode {
	const parsed = parseExitCode(value);
	if (!parsed.ok) throw new Error('bad exit code');
	return parsed.value;
}

describe('runGit', () => {
	it('runs git with arguments passed as they are, never through a shell', async () => {
		const repo = await emptyRepo();
		const message = 'a "quoted" $HOME `tick` ; message';
		await repo.git('commit', '--allow-empty', '--quiet', '-m', message);
		const result = await runGitText({ cwd: repo.dir, args: ['log', '-1', '--format=%s'] });
		expect(result).toEqual({ ok: true, value: message });
	});

	it('passes input on stdin', async () => {
		const repo = await emptyRepo();
		const result = await runGitText({
			cwd: repo.dir,
			args: ['hash-object', '--stdin'],
			input: 'hello\n'
		});
		expect(result).toEqual({ ok: true, value: 'ce013625030ba8dba906f756967f9e9ca394464a' });
	});

	it('ignores the global git config of the machine', async () => {
		const repo = await emptyRepo();
		const result = await runGitText({
			cwd: repo.dir,
			args: ['config', '--global', '--list'],
			env: { HOME: '/nonexistent' }
		});
		expect(result.ok ? result.value : 'failed').toBe('');
	});

	it('reports a directory that is not a repository', async () => {
		const repo = await emptyRepo();
		const plain = join(repo.dir, '..', `${repo.dir.split('/').at(-1) ?? ''}-plain`);
		await mkdir(plain);
		const result = await runGit({
			cwd: absolutePath(plain),
			args: ['rev-parse', 'HEAD'],
			env: { GIT_CEILING_DIRECTORIES: join(plain, '..') }
		});
		expect(result.ok ? undefined : result.error.kind).toBe('NotARepository');
	});

	it('reports a directory that does not exist', async () => {
		const result = await runGit({
			cwd: absolutePath('/nonexistent/diff-delver'),
			args: ['status']
		});
		expect(result).toEqual({
			ok: false,
			error: { kind: 'NotARepository', directory: '/nonexistent/diff-delver', stderr: '' }
		});
	});

	it('reports an unknown revision', async () => {
		const repo = await emptyRepo();
		const result = await runGit({ cwd: repo.dir, args: ['rev-parse', '--verify', 'nope^{tree}'] });
		expect(result.ok ? undefined : result.error.kind).toBe('BadRevision');
	});

	it('reports any other failure with its exit code and stderr', async () => {
		const repo = await emptyRepo();
		const result = await runGit({ cwd: repo.dir, args: ['no-such-command'] });
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === 'GitFailed') {
			expect(result.error.exitCode).toBe(1);
			expect(result.error.stderr).toContain('no-such-command');
		} else {
			expect.unreachable('expected GitFailed');
		}
	});

	it('has a message for every error', () => {
		const errors: readonly GitError[] = [
			{ kind: 'GitNotFound' },
			{ kind: 'NotARepository', directory: absolutePath('/x'), stderr: gitStderr('') },
			{ kind: 'BadRevision', args: ['diff-tree'], stderr: gitStderr('fatal: bad revision') },
			{
				kind: 'GitFailed',
				args: ['diff-tree'],
				exitCode: exitCode(128),
				stderr: gitStderr('fatal: oops')
			},
			{
				kind: 'GitFailed',
				args: ['-c', 'a=b', 'diff-tree'],
				exitCode: undefined,
				stderr: gitStderr('')
			}
		];
		expect(describeGitError(errors[4] ?? { kind: 'GitNotFound' })).toMatch(
			/^git diff-tree failed \(it stopped before it could finish\)/
		);
		for (const error of errors) expect(describeGitError(error).length).toBeGreaterThan(20);
	});
});
