/**
 * What a recording writes as placeholders: everything that varies by machine
 * or run, in every form a CLI writes it.
 */
import { describe, expect, it } from 'vitest';
import { normaliser } from './recording.ts';

describe('a recording’s placeholders', () => {
	const normalise = normaliser({
		repository: '/tmp/diff-delver-trial-c429n9/work/shop',
		data: '/tmp/diff-delver-trial-c429n9/data',
		trial: '/tmp/diff-delver-trial-c429n9',
		home: '/home/someone',
		user: 'someone'
	});

	it('writes the trial’s folders as placeholders, and as a CLI names a folder after them', () => {
		expect(
			normalise(
				'{"auto":"/tmp/diff-delver-trial-c429n9/home/.claude/projects/-tmp-diff-delver-trial-c429n9-work-shop/memory/"}'
			)
		).toBe('{"auto":"<trial>/home/.claude/projects/<repository-dashed>/memory/"}');
		expect(normalise('/tmp/diff-delver-trial-c429n9/data/daemon.lock')).toBe('<data>/daemon.lock');
	});

	it('writes a trial folder named after another run’s as a placeholder too, for older recordings', () => {
		expect(
			normalise('<trial>/home/.claude/projects/-tmp-diff-delver-trial-EWxZa7-work-shop/memory/')
		).toBe('<trial>/home/.claude/projects/<trial-dashed>-work-shop/memory/');
		expect(normalise('-var-folders-x1-T-diff-delver-trial-5ya31o-work-ledger')).toBe(
			'<trial-dashed>-work-ledger'
		);
		expect(normalise('a-diff-delver-trial-abcdef1 stays')).toBe(
			'a-diff-delver-trial-abcdef1 stays'
		);
	});

	it('writes the login shell a command ran in as a placeholder, and leaves the command', () => {
		expect(normalise("shell: /usr/bin/zsh -lc 'git status --short'")).toBe(
			"shell: <shell> -lc 'git status --short'"
		);
		expect(normalise('shell: /bin/bash -c ls')).toBe('shell: <shell> -c ls');
		expect(normalise('#!/bin/sh\necho done')).toBe('#!/bin/sh\necho done');
	});

	it('writes the home folder, the user name, the port and entry codes as placeholders', () => {
		expect(normalise('/home/someone/x someone http://127.0.0.1:4321/diffs/r_1?code=abc-123')).toBe(
			'<home>/x <user> http://127.0.0.1:<port>/diffs/r_1?code=<code>'
		);
	});
});
