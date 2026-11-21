import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbitraryDiff } from '../../../../tests/support/synthetic-diff.ts';
import awkward from './fixtures/awkward-changes.diff-tree?raw';
import { agentPath, hiddenShown, renderAgentDiff, renderAgentFile } from './agent-text.ts';
import { assign, pathsNamedBy, type AssignRequest } from './assign.ts';
import { parseDiffTreeOutput } from './diff-tree-output.ts';
import { makeDiff, type Diff, type DiffFile } from './diff.ts';
import { initialState } from './state.ts';
import { characterCount } from '../character-count.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';

function repoPath(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(`bad path ${text}`);
	return parsed.value;
}

function awkwardDiff(): Diff {
	const files = parseDiffTreeOutput(new TextEncoder().encode(awkward));
	if (!files.ok) throw new Error('fixture does not parse');
	const diff = makeDiff(files.value);
	if (!diff.ok) throw new Error('fixture does not index');
	return diff.value;
}

const diff = awkwardDiff();

function file(path: string): DiffFile {
	const found = diff.files.find((f) => f.file.path === path);
	if (found === undefined) throw new Error(`no ${path}`);
	return found;
}

describe('renderAgentFile', () => {
	it('labels changed lines and hunks the way assign accepts them', () => {
		expect(renderAgentFile(file('modified.txt'))).toBe(
			[
				'## modified.txt',
				'modified',
				'@@ h1 -1,6 +1,6 @@',
				'    one',
				'',
				'-3  three',
				'+3  THREE',
				'    four',
				'    five',
				'    six',
				'@@ h2 -8,3 +8,4 @@ seven',
				'    eight',
				'    nine',
				'    ten',
				'+11 eleven'
			].join('\n')
		);
	});

	it('says how a file without lines changed and that it is assigned whole', () => {
		expect(renderAgentFile(file('renamed-after.txt'))).toBe(
			'## renamed-after.txt\nrenamed from renamed-before.txt (100% similar), no changed lines: assign the whole file\nfile renamed from renamed-before.txt'
		);
		expect(renderAgentFile(file('mode.sh')).split('\n')[1]).toBe(
			'modified, mode 100644 → 100755, no changed lines: assign the whole file'
		);
		expect(renderAgentFile(file('binary.bin')).split('\n')[1]).toBe(
			'modified, binary, no changed lines: assign the whole file'
		);
		expect(renderAgentFile(file('vendor/lib')).split('\n')[1]).toBe(
			'modified, submodule 111111111111 → 222222222222, no changed lines: assign the whole file'
		);
		expect(renderAgentFile(file('becomes-link.txt')).split('\n').slice(1, 3)).toEqual([
			'changed from file to symlink',
			'file became a link'
		]);
	});

	it('marks missing final newlines and carriage returns', () => {
		expect(renderAgentFile(file('no-newline.txt')).split('\n').slice(2)).toEqual([
			'@@ h1 -1,2 +1,2 @@',
			'   a',
			'-2 b',
			'\\ No newline at end of file',
			'+2 c',
			'\\ No newline at end of file'
		]);
		expect(renderAgentFile(file('crlf.txt'))).toContain('-2 two\\r\n+2 TWO\\r');
	});

	it('writes characters that cannot be seen or turn text round as the page does, but for a tab', () => {
		expect(hiddenShown('\x1B[2Jclear\tthen\u202Eevil\u200B\r')).toBe(
			'\\x1B[2Jclear\tthen\\u202Eevil\\u200B\\r'
		);
		expect(hiddenShown('a\u2028b\u0085c\vd\fe')).toBe('a\\u2028b\\u0085c\\x0Bd\\x0Ce');
	});

	it('cuts very long lines', () => {
		const text = renderAgentFile(file('long-line.txt'), { maxLineLength: characterCount(10) });
		expect(text).toContain('-1 xxxxxxxxxx… [19990 more characters]');
	});

	it('quotes paths that cannot be copied as they are', () => {
		expect(agentPath(repoPath('src/app.ts'))).toBe('src/app.ts');
		expect(agentPath(repoPath('odd names/with space.txt'))).toBe('odd names/with space.txt');
		expect(agentPath(repoPath('odd names/new\nline.txt'))).toBe('"odd names/new\\nline.txt"');
		expect(agentPath(repoPath('odd names/ünïcödé "quoted".txt'))).toBe(
			'"odd names/ünïcödé \\"quoted\\".txt"'
		);
		expect(agentPath(repoPath('caf\uDCE9.txt'))).toBe('"caf\\\\xE9.txt"');
		expect(agentPath(repoPath('a\u2028b.txt'))).toBe('"a\\u2028b.txt"');
		// Characters that cannot be seen or turn text round, and ": ", are quoted too, as escapes.
		const odd: readonly (readonly [string, string])[] = [
			['report\u202Etxt.exe', '"report\\u202Etxt.exe"'],
			['a\u200Bb.txt', '"a\\u200Bb.txt"'],
			['bom\uFEFF.txt', '"bom\\uFEFF.txt"'],
			['next\u0085line', '"next\\u0085line"'],
			['del\u007F', '"del\\u007F"'],
			['src/a.ts: modified, +1 -0', '"src/a.ts: modified, +1 -0"']
		];
		for (const [text, shown] of odd) {
			const path = repoPath(text);
			expect(agentPath(path)).toBe(shown);
			// What is shown names the file, as a JSON string's value or as it is written.
			const parsed: unknown = JSON.parse(shown);
			expect(pathsNamedBy(shown)).toContain(path);
			expect(typeof parsed === 'string' ? pathsNamedBy(parsed) : []).toContain(path);
		}
		expect(agentPath(repoPath('a:b.txt'))).toBe('a:b.txt');
		expect(renderAgentFile(file('odd names/ünïcödé "quoted".txt')).split('\n')[1]).toBe(
			'renamed from odd names/with space.txt (100% similar), no changed lines: assign the whole file'
		);
	});
});

/** The `assign` requests that the labels in the text spell out, one per file and one per hunk. */
function requestsFromText(text: string): readonly AssignRequest[] {
	const requests: AssignRequest[] = [];
	for (const block of text.split(/\n\n(?=## )/)) {
		const [heading = '', ...rest] = block.split('\n');
		const quoted = heading.slice(3);
		const path = quoted.startsWith('"') ? String(JSON.parse(quoted)) : quoted;
		const labels = rest.map((l) => /^(file|[+-]\d+) /.exec(l)?.[1]).filter((l) => l !== undefined);
		const hunks = rest.map((l) => /^@@ (h\d+) /.exec(l)?.[1]).filter((h) => h !== undefined);
		if (labels.length > 0)
			requests.push({ file: path, lines: labels.join(','), section: 'by-line' });
		if (hunks.length > 0) requests.push({ file: path, hunks, role: 'test' });
		if (labels.length === 0) requests.push({ file: path, section: 'whole' });
	}
	return requests;
}

describe('the agent text round trip', () => {
	const roundTrip = (d: Diff): void => {
		const requests = requestsFromText(renderAgentDiff(d.files));
		const outcome = assign(d, initialState(d), requests);
		expect(outcome.rejected).toEqual([]);
		expect(outcome.uncategorised).toBe(0);
		const byLine = requests.filter((r) => r.section === 'by-line').length;
		const lineUnits = outcome.accepted
			.filter((a) => requests[a.index]?.section === 'by-line')
			.reduce((n, a) => n + a.units, 0);
		// Every file has a label: its changed lines, its file-level unit, or both.
		expect(byLine).toBe(d.files.length);
		expect(lineUnits).toBe(d.unitCount);
	};

	it('takes exactly each hunk when given the spans from its header, context and all', () => {
		fc.assert(
			fc.property(arbitraryDiff, (d) => {
				const requests: AssignRequest[] = [];
				for (const block of renderAgentDiff(d.files).split(/\n\n(?=## )/)) {
					const [heading = '', ...rest] = block.split('\n');
					const quoted = heading.slice(3);
					const path = quoted.startsWith('"') ? String(JSON.parse(quoted)) : quoted;
					for (const line of rest) {
						const match = /^@@ h\d+ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
						if (match === null) continue;
						const [, os = '', ol = '', ns = '', nl = ''] = match;
						const body = rest.slice(rest.indexOf(line) + 1);
						const end = body.findIndex((l) => l.startsWith('@@ '));
						const hunk = end === -1 ? body : body.slice(0, end);
						const spans: string[] = [];
						if (hunk.some((l) => l.startsWith('-')))
							spans.push(`-${os}..-${String(Number(os) + Number(ol) - 1)}`);
						if (hunk.some((l) => l.startsWith('+')))
							spans.push(`+${ns}..+${String(Number(ns) + Number(nl) - 1)}`);
						requests.push({ file: path, lines: spans.join(','), section: 'by-span' });
					}
				}
				const outcome = assign(d, initialState(d), requests);
				expect(outcome.rejected).toEqual([]);
				const lineUnits = d.files.reduce((n, f) => n + f.changed.old.size + f.changed.new.size, 0);
				expect(outcome.accepted.reduce((n, a) => n + a.units, 0)).toBe(lineUnits);
			}),
			{ numRuns: 60 }
		);
	});

	it('accepts every label of the recorded awkward diff', () => {
		roundTrip(diff);
	});

	it('accepts every label of any diff', () => {
		fc.assert(
			fc.property(arbitraryDiff, (d) => {
				roundTrip(d);
			}),
			{ numRuns: 60 }
		);
	});
});
