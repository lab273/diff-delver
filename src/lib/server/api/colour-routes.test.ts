/**
 * Colouring code and the person's settings, against a real daemon through the
 * typed client: lines coloured as part of their whole file, so a line inside a
 * block comment whose opening is not shown is still a comment; a file of no
 * known language, a binary one and one too large to colour shown plain; and
 * settings kept in the data folder, across a restart.
 */
import { describe, expect, it } from 'vitest';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { spansOf } from '#lib/core/viewer/line-spans.ts';
import { clientOf, testDaemon } from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';

const COMMENT = ['/*', ...Array.from({ length: 30 }, (_, i) => ` * note ${String(i)}`), ' */'];

const coloured = defineFixture('colour-routes', async (repo) => {
	await repo.write('src/lexer.ts', [...COMMENT, 'export const a = 1;', ''].join('\n'));
	await repo.write('notes.txt', 'plain\n');
	await repo.write('min.js', `var a=${'1+'.repeat(20_000)}1;\n`);
	await repo.write('bin/tool', '#!/bin/sh\necho old\n');
	await repo.commit('base');
	// A change inside the comment, far from its opening, and one after it.
	const changed = [...COMMENT];
	changed[25] = ' * note changed';
	await repo.write('src/lexer.ts', [...changed, 'export const a = 2;', ''].join('\n'));
	await repo.write('notes.txt', 'still plain\n');
	await repo.write('min.js', `var a=${'2+'.repeat(20_000)}2;\n`);
	await repo.write('bin/tool', '#!/bin/sh\necho new\n');
});

const BODY = Array.from({ length: 12 }, (_, i) => `export const v${String(i)} = "${String(i)}";`);
const OTHER = Array.from(
	{ length: 12 },
	(_, i) => `export let other${String(i)} = [${String(i)}];`
);

/** Files that moved: each side is read at its own path and coloured in its own language. */
const moved = defineFixture('colour-routes-moved', async (repo) => {
	await repo.write('old/a.ts', [...BODY, ''].join('\n'));
	await repo.write('copy/source.ts', [...OTHER, ''].join('\n'));
	await repo.write(
		'script.py',
		['def f():', '    return "x"', ...BODY.map((l) => `# ${l}`), ''].join('\n')
	);
	await repo.commit('base');
	await repo.remove('old/a.ts');
	const edited = [...BODY];
	edited[5] = 'export const v5 = "changed";';
	await repo.write('new/b.ts', [...edited, ''].join('\n'));
	// A copy is found when its source changes too.
	const copied = [...OTHER];
	copied[5] = 'export let other5 = ["changed"];';
	await repo.write('copy/target.ts', [...copied, ''].join('\n'));
	await repo.write('copy/source.ts', [...OTHER, 'export const more = 1;', ''].join('\n'));
	await repo.remove('script.py');
	await repo.write(
		'script.ts',
		['def f():', '    return "y"', ...BODY.map((l) => `# ${l}`), ''].join('\n')
	);
});

const lines = (...numbers: number[]) => spansOf(numbers.map(lineNumberOf));
const version = value(parseRevisionNumber(1));
const path = (text: string) => escapedRepoPath(value(parseRepoPath(text)));

describe('colouring code', () => {
	it('colours lines as part of their whole file, and says why a file is plain', async () => {
		const repo = await useFixture(coloured);
		const daemon = await testDaemon();
		try {
			const client = clientOf(daemon);
			const started = value(await client.start({ directory: repo.dir }));
			if (started.kind !== 'opened') throw new Error(started.kind);
			const id = started.diff.id;

			const lexer = value(
				await client.readColours(id, {
					version,
					path: path('src/lexer.ts'),
					old: lines(26),
					new: lines(26, 33)
				})
			);
			// Line 26 is deep inside a comment whose opening, line 1, was not asked for.
			expect(lexer.old).toEqual({
				kind: 'coloured',
				lines: [{ number: 26, runs: [{ start: 0, length: 10, kind: 'comment' }] }]
			});
			if (lexer.new?.kind !== 'coloured') throw new Error('not coloured');
			expect(lexer.new.lines[0]).toEqual({
				number: 26,
				runs: [{ start: 0, length: 15, kind: 'comment' }]
			});
			expect(lexer.new.lines[1]?.number).toBe(33);
			expect(lexer.new.lines[1]?.runs.map((r) => r.kind)).toContain('keyword');

			// A file with no extension is coloured by the interpreter its #! line names.
			const tool = value(
				await client.readColours(id, { version, path: path('bin/tool'), old: [], new: lines(2) })
			);
			expect(tool.old).toBeNull();
			expect(tool.new?.kind).toBe('coloured');

			const notes = value(
				await client.readColours(id, {
					version,
					path: path('notes.txt'),
					old: lines(1),
					new: lines(1)
				})
			);
			expect(notes).toEqual({
				old: { kind: 'plain', reason: 'language' },
				new: { kind: 'plain', reason: 'language' }
			});
			const minified = value(
				await client.readColours(id, { version, path: path('min.js'), old: [], new: lines(1) })
			);
			expect(minified.new).toEqual({ kind: 'plain', reason: 'minified' });
		} finally {
			await daemon.stop();
		}
	});
});

describe('colouring a file that moved', () => {
	it('colours the removed lines of a renamed or copied file from its old path, in that path’s language', async () => {
		const repo = await useFixture(moved);
		const daemon = await testDaemon();
		try {
			const client = clientOf(daemon);
			const started = value(await client.start({ directory: repo.dir }));
			if (started.kind !== 'opened') throw new Error(started.kind);
			const id = started.diff.id;
			const frame = value(await client.loadDiff(id));
			const change = new Map(frame.files.map((f) => [String(f.path), String(f.change)]));
			expect(change.get('new/b.ts')).toContain('renamed from old/a.ts');
			expect(change.get('copy/target.ts')).toContain('copied from copy/source.ts');
			expect(change.get('script.ts')).toContain('renamed from script.py');

			for (const target of ['new/b.ts', 'copy/target.ts']) {
				const read = value(
					await client.readColours(id, {
						version,
						path: path(target),
						old: lines(6),
						new: lines(6)
					})
				);
				if (read.old?.kind !== 'coloured') throw new Error(`${target}: old side not coloured`);
				expect(read.old.lines[0]?.runs.map((r) => r.kind)).toContain('keyword');
			}

			// script.py became script.ts: the old side is Python, so `def` is a keyword
			// and `#` starts a comment; the new side is TypeScript, where neither is.
			const script = value(
				await client.readColours(id, {
					version,
					path: path('script.ts'),
					old: lines(1, 3),
					new: lines(1, 3)
				})
			);
			if (script.old?.kind !== 'coloured' || script.new?.kind !== 'coloured') {
				throw new Error('not coloured');
			}
			expect(script.old.lines.find((l) => l.number === 1)?.runs[0]).toEqual({
				start: 0,
				length: 3,
				kind: 'keyword'
			});
			expect(script.old.lines.find((l) => l.number === 3)?.runs.map((r) => r.kind)).toEqual([
				'comment'
			]);
			expect(script.new.lines.find((l) => l.number === 3)?.runs.map((r) => r.kind)).not.toEqual([
				'comment'
			]);
		} finally {
			await daemon.stop();
		}
	});

	it('answers that a path not in the diff is not in it', async () => {
		const repo = await useFixture(moved);
		const daemon = await testDaemon();
		try {
			const client = clientOf(daemon);
			const started = value(await client.start({ directory: repo.dir }));
			if (started.kind !== 'opened') throw new Error(started.kind);
			const read = await client.readColours(started.diff.id, {
				version,
				path: path('old/a.ts'),
				old: lines(1),
				new: []
			});
			expect(read.ok).toBe(false);
		} finally {
			await daemon.stop();
		}
	});
});

describe('the person’s settings', () => {
	it('start at their defaults and are kept in the data folder, across a restart', async () => {
		const dataDirectory = await tempDirectory();
		const first = await testDaemon({ dataDirectory });
		try {
			const client = clientOf(first);
			expect(value(await client.readSettings())).toEqual({
				colours: true,
				layout: 'unified',
				hideWhiteSpace: false,
				searchMatchCase: false,
				searchChangedOnly: false,
				searchSkipClosed: false
			});
			value(await client.changeSetting({ name: 'colours', value: false }));
			value(await client.changeSetting({ name: 'hide-white-space', value: true }));
			value(await client.changeSetting({ name: 'search-match-case', value: true }));
			value(await client.changeSetting({ name: 'search-skip-closed', value: true }));
			expect(value(await client.changeSetting({ name: 'layout', value: 'side-by-side' }))).toEqual({
				colours: false,
				layout: 'side-by-side',
				hideWhiteSpace: true,
				searchMatchCase: true,
				searchChangedOnly: false,
				searchSkipClosed: true
			});
		} finally {
			await first.stop();
		}
		const second = await testDaemon({ dataDirectory });
		try {
			expect(value(await clientOf(second).readSettings())).toEqual({
				colours: false,
				layout: 'side-by-side',
				hideWhiteSpace: true,
				searchMatchCase: true,
				searchChangedOnly: false,
				searchSkipClosed: true
			});
		} finally {
			await second.stop();
		}
	});
});
