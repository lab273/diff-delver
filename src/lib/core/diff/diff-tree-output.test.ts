import { describe, expect, it } from 'vitest';
import awkward from './fixtures/awkward-changes.diff-tree?raw';
import emptyAdded from './fixtures/empty-file-added.diff-tree?raw';
import sha256 from './fixtures/sha256-repository.diff-tree?raw';
import { describeDiffOutputError, type DiffOutputError } from './diff-output-error.ts';
import { parseDiffTreeOutput } from './diff-tree-output.ts';
import type { DiffLine, FileDiff } from './file-diff.ts';
import { byteOffsetAt } from '../byte-offset.tiny.ts';
import { fileCountOf } from '../file-count.tiny.ts';
import { parseLineNumber, type LineNumber } from '../line-number.tiny.ts';
import { patchCountOf } from '../patch-count.tiny.ts';

function lineNumber(value: number): LineNumber {
	const parsed = parseLineNumber(value);
	if (!parsed.ok) throw new Error(`bad line ${String(value)}`);
	return parsed.value;
}

/** The recorded fixtures are UTF-8 throughout, so their text encodes back to git's exact bytes. */
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function files(output: string): readonly FileDiff[] {
	const result = parseDiffTreeOutput(bytesOf(output));
	if (!result.ok) throw new Error(describeDiffOutputError(result.error));
	return result.value;
}

const awkwardFiles = files(awkward);

function file(path: string): FileDiff {
	const found = awkwardFiles.find((f) => f.path === path);
	if (found === undefined) throw new Error(`no ${path} in the fixture`);
	return found;
}

/** A line as `+3 text`, `-3 text` or ` 3,4 text`, for compact expectations. */
function show(line: DiffLine): string {
	const end = line.noNewlineAtEnd ? ' ⏎̸' : '';
	switch (line.kind) {
		case 'added':
			return `+${line.new} ${line.text}${end}`;
		case 'deleted':
			return `-${line.old} ${line.text}${end}`;
		case 'context':
			return ` ${line.old},${line.new} ${line.text}${end}`;
	}
}

function shownHunks(f: FileDiff): readonly (readonly string[])[] {
	return f.content.kind === 'text' ? f.content.hunks.map((h) => h.lines.map(show)) : [];
}

describe('parseDiffTreeOutput on recorded git output', () => {
	it('lists every changed file once, by the path it is known by', () => {
		expect(awkwardFiles.map((f) => [f.status, f.path])).toEqual([
			['added', 'added.txt'],
			['added', 'assets/logo.png'],
			['type-changed', 'becomes-link.txt'],
			['type-changed', 'becomes-submodule'],
			['modified', 'binary.bin'],
			['modified', 'copy-source.txt'],
			['copied', 'copy-target.txt'],
			['modified', 'crlf.txt'],
			['deleted', 'deleted.txt'],
			['renamed', 'edited-after.txt'],
			['deleted', 'empty-deleted'],
			['modified', 'long-line.txt'],
			['modified', 'mode.sh'],
			['modified', 'modified.txt'],
			['modified', 'no-newline.txt'],
			['added', 'odd names/new\nline.txt'],
			['added', 'odd names/tab\there.txt'],
			['renamed', 'odd names/ünïcödé "quoted".txt'],
			['renamed', 'renamed-after.txt'],
			['modified', 'separators.js'],
			['added', 'vendor/added'],
			['modified', 'vendor/lib']
		]);
	});

	it('reads a modification with several hunks, keeping blank context lines', () => {
		const f = file('modified.txt');
		expect(f.old?.path).toBe('modified.txt');
		expect(f.old?.mode).toBe('100644');
		expect(f.old?.blob).toBe('1cccd1b6971a153f9a790d629980cd899faaea84');
		expect(f.content.kind === 'text' && f.content.hunks.map((h) => [h.id, h.old, h.new])).toEqual([
			['h1', { start: 1, length: 6 }, { start: 1, length: 6 }],
			['h2', { start: 8, length: 3 }, { start: 8, length: 4 }]
		]);
		expect(shownHunks(f)).toEqual([
			[' 1,1 one', ' 2,2 ', '-3 three', '+3 THREE', ' 4,4 four', ' 5,5 five', ' 6,6 six'],
			[' 8,8 eight', ' 9,9 nine', ' 10,10 ten', '+11 eleven']
		]);
		expect(f.content.kind === 'text' && f.content.hunks[1]?.heading).toBe('seven');
	});

	it('reads an added file and a deleted one, with no object on the missing side', () => {
		const added = file('added.txt');
		expect(added.old).toBeUndefined();
		expect(added.new?.path).toBe('added.txt');
		expect(shownHunks(added)).toEqual([['+1 new', '+2 file']]);

		const deleted = file('deleted.txt');
		expect(deleted.new).toBeUndefined();
		expect(shownHunks(deleted)).toEqual([['-1 gone', '-2 for', '-3 good']]);
	});

	it('reads renames with and without edits', () => {
		const pure = file('renamed-after.txt');
		expect([pure.old?.path, pure.new?.path, pure.similarity]).toEqual([
			'renamed-before.txt',
			'renamed-after.txt',
			100
		]);
		expect(pure.content).toEqual({ kind: 'text', hunks: [] });

		const edited = file('edited-after.txt');
		expect([edited.old?.path, edited.similarity]).toEqual(['edited-before.txt', 88]);
		expect(shownHunks(edited)[0]?.filter((l) => !l.startsWith(' '))).toEqual([
			'-5 rename with edits line 5',
			'+5 rename with edits line five'
		]);
	});

	it('reads a copy and the edit to its source', () => {
		const copy = file('copy-target.txt');
		expect([copy.old?.path, copy.new?.path, copy.similarity]).toEqual([
			'copy-source.txt',
			'copy-target.txt',
			100
		]);
		expect(copy.content).toEqual({ kind: 'text', hunks: [] });
		expect(shownHunks(file('copy-source.txt'))[0]?.at(-1)).toBe('+11 one more');
	});

	it('reads a change of mode alone as a modification with no hunks', () => {
		const f = file('mode.sh');
		expect([f.old?.mode, f.new?.mode]).toEqual(['100644', '100755']);
		expect(f.content).toEqual({ kind: 'text', hunks: [] });
	});

	it('joins the two patches git writes for a file that became a symlink', () => {
		const f = file('becomes-link.txt');
		expect([f.old?.mode, f.new?.mode]).toEqual(['100644', '120000']);
		expect(f.content.kind === 'text' && f.content.hunks.map((h) => h.id)).toEqual(['h1', 'h2']);
		expect(shownHunks(f)).toEqual([['-1 link me'], ['+1 modified.txt ⏎̸']]);
	});

	it('gives binary files and submodules no lines', () => {
		expect(file('binary.bin').content).toEqual({ kind: 'binary' });
		expect(file('assets/logo.png').content).toEqual({ kind: 'binary' });
		expect(file('vendor/lib').content).toEqual({ kind: 'submodule' });
		expect([file('vendor/lib').old?.blob, file('vendor/lib').new?.blob]).toEqual([
			'1'.repeat(40),
			'2'.repeat(40)
		]);
		expect(file('vendor/added').content).toEqual({ kind: 'submodule' });
		expect(file('becomes-submodule').content).toEqual({ kind: 'submodule' });
	});

	it('marks lines with no newline at the end of the file', () => {
		expect(shownHunks(file('no-newline.txt'))).toEqual([[' 1,1 a', '-2 b ⏎̸', '+2 c ⏎̸']]);
	});

	it('keeps the carriage returns of CRLF lines', () => {
		expect(shownHunks(file('crlf.txt'))).toEqual([
			[' 1,1 one\r', '-2 two\r', '+2 TWO\r', ' 3,3 three\r']
		]);
	});

	it('treats only a newline as the end of a line, in hunk headings and in content', () => {
		const f = file('separators.js');
		expect(f.content.kind === 'text' && f.content.hunks.map((h) => h.heading)).toEqual([
			'function lineSeparator() { "\u2028" }',
			'function paragraphSeparator() { "\u2029" }',
			'function carriageReturn() { "\r" }',
			'function formFeed() { "\f" }',
			'function verticalTab() { "\v" }',
			'function nextLine() { "\u0085" }'
		]);
		expect(shownHunks(f)[0]?.filter((l) => !l.startsWith(' '))).toEqual([
			'-8   filler 6',
			'+8   edited 0\u2028here'
		]);
	});

	it('reads very long lines whole', () => {
		const [hunk] = shownHunks(file('long-line.txt'));
		expect(hunk?.map((l) => l.length)).toEqual([20_003, 20_003]);
	});

	it('takes paths with spaces, quotes, tabs, newlines and accents exactly', () => {
		const odd = awkwardFiles.filter((f) => f.path.startsWith('odd names/'));
		expect(odd.map((f) => [f.old?.path, f.new?.path])).toEqual([
			[undefined, 'odd names/new\nline.txt'],
			[undefined, 'odd names/tab\there.txt'],
			['odd names/with space.txt', 'odd names/ünïcödé "quoted".txt']
		]);
	});

	it('keeps paths that are not UTF-8 exact and distinct', () => {
		const listing = (byte: number): number[] => [
			...bytesOf(`:000000 100644 ${'0'.repeat(40)} ${'b'.repeat(40)} A\0caf`),
			byte,
			...bytesOf('.txt\0')
		];
		const patch = (octal: string): string =>
			`diff --git "a/caf\\${octal}.txt" "b/caf\\${octal}.txt"\nnew file mode 100644\n` +
			`--- /dev/null\n+++ "b/caf\\${octal}.txt"\n@@ -0,0 +1 @@\n+x\n`;
		const output = Uint8Array.from([
			...listing(0xe8),
			...listing(0xe9),
			0,
			...bytesOf(patch('350') + patch('351'))
		]);
		const result = parseDiffTreeOutput(output);
		expect(result.ok && result.value.map((f) => f.path)).toEqual([
			'caf\uDCE8.txt',
			'caf\uDCE9.txt'
		]);
	});

	it('reads a deleted empty file and an added one as file-level changes', () => {
		expect(file('empty-deleted').content).toEqual({ kind: 'text', hunks: [] });
		const [added] = files(emptyAdded);
		expect([added?.status, added?.path, added?.content]).toEqual([
			'added',
			'empty',
			{ kind: 'text', hunks: [] }
		]);
	});

	it('reads SHA-256 object ids', () => {
		const [f] = files(sha256);
		expect(f?.old?.blob).toHaveLength(64);
		expect(f?.new?.blob).toHaveLength(64);
	});

	it('reads no output as no changes', () => {
		expect(files('')).toEqual([]);
	});
});

describe('parseDiffTreeOutput on damaged output', () => {
	const kind = (output: string): DiffOutputError['kind'] | undefined => {
		const result = parseDiffTreeOutput(bytesOf(output));
		return result.ok ? undefined : result.error.kind;
	};
	const [listing = '', patch = ''] = sha256.split('\0\0');

	it('notices a patch missing for a listed file', () => {
		expect(kind(`${listing}\0\0`)).toBe('PatchCountMismatch');
	});

	it('notices a patch that does not match the status', () => {
		expect(kind(`${listing.replace(' M\0', ' D\0')}\0\0${patch}`)).toBe('PatchMismatch');
	});

	it('notices a damaged listing', () => {
		expect(kind(listing.replace(':100644', ':10064x'))).toBe('MalformedRawListing');
		expect(kind(listing.slice(0, -1))).toBe('MalformedRawListing');
	});

	it('notices a damaged hunk', () => {
		expect(kind(`${listing}\0\0${patch.replace('+after', '?after')}`)).toBe('MalformedPatch');
		expect(kind(`${listing}\0\0${patch.replace('@@ -1 +1 @@', '@@ -1 +1,2 @@')}`)).toBe(
			'MalformedPatch'
		);
		expect(kind(`${listing}\0\0${patch}trailing junk\n`)).toBe('MalformedPatch');
	});

	it('has a message for every error', () => {
		const errors: readonly DiffOutputError[] = [
			{ kind: 'MalformedRawListing', offset: byteOffsetAt(3), detail: 'x' },
			{ kind: 'MalformedPatch', line: lineNumber(3), detail: 'x' },
			{
				kind: 'PatchCountMismatch',
				listedFiles: fileCountOf(1),
				expectedPatches: patchCountOf(1),
				foundPatches: patchCountOf(0)
			},
			{ kind: 'PatchMismatch', path: file('added.txt').path, status: 'added', detail: 'x' }
		];
		for (const error of errors) expect(describeDiffOutputError(error)).toMatch(/bug/);
	});
});
