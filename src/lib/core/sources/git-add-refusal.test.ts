import { describe, expect, it } from 'vitest';
import { describeAddRefusals, parseAddRefusals } from './git-add-refusal.ts';

describe('what git add refused', () => {
	it('gives one plain sentence per file, with the most specific reason, sorted by path', () => {
		const stderr = [
			'error: open("dir/a.txt"): Permission denied',
			"error: unable to index file 'dir/a.txt'",
			'error: fifo: can only add regular files, symbolic links or git-directories',
			"error: 'nested/' does not have a commit checked out",
			"error: unable to index file 'nested/'",
			"warning: could not open directory 'locked/': Permission denied",
			"error: unable to index file 'other'",
			"warning: in the working copy of 'crlf.txt', LF will be replaced by CRLF the next time Git touches it",
			''
		].join('\n');
		expect(describeAddRefusals(parseAddRefusals(stderr))).toEqual([
			'Not included: dir/a.txt, which could not be read (permission denied). Check that you can read it, then refresh.',
			'Not included: fifo, which is not a file, folder or symbolic link (it may be a named pipe, a socket or a device), so it cannot be part of a snapshot.',
			'Not included: the folder locked, which could not be opened (permission denied), so nothing in it is included. Check that you can open it, then refresh.',
			'Not included: nested, a repository inside this one with no commits yet, so there is no commit to record for it. Make a commit in it, or remove it, then refresh.',
			'Not included: other, which git could not add. Check that you can read it, then refresh.'
		]);
	});

	it('never shows an error it does not recognise as git wrote it', () => {
		const found = parseAddRefusals('error: something new went wrong with x\n');
		expect(found.refusals).toEqual([]);
		expect(describeAddRefusals(found)).toEqual([
			'Some other file could not be included, for a reason diff delver does not recognise. Check that every changed file can be read, then refresh.'
		]);
	});

	it('finds nothing when git refused nothing', () => {
		expect(describeAddRefusals(parseAddRefusals(''))).toEqual([]);
	});
});
