import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbitraryDiff } from '../../../../tests/support/synthetic-diff.ts';
import awkward from './fixtures/awkward-changes.diff-tree?raw';
import { agentPath, renderAgentDiff, renderAgentFile } from './agent-text.ts';
import { assign, type AssignRequest } from './assign.ts';
import { parseDiffTreeOutput } from './diff-tree-output.ts';
import { makeDiff, type Diff, type DiffFile } from './diff.ts';
import { initialState } from './state.ts';

function awkwardDiff(): Diff {
	const files = parseDiffTreeOutput(awkward);
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
			'## renamed-after.txt\nrenamed from renamed-before.txt (100% similar), no changed lines: assign the whole file'
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
			'@@ h1 -1,1 +0,0 @@'
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

	it('cuts very long lines', () => {
		const text = renderAgentFile(file('long-line.txt'), { maxLineLength: 10 });
		expect(text).toContain('-1 xxxxxxxxxx… [19990 more characters]');
	});

	it('quotes paths that cannot be copied as they are', () => {
		expect(agentPath('src/app.ts')).toBe('src/app.ts');
		expect(agentPath('odd names/with space.txt')).toBe('odd names/with space.txt');
		expect(agentPath('odd names/new\nline.txt')).toBe('"odd names/new\\nline.txt"');
		expect(agentPath('odd names/ünïcödé "quoted".txt')).toBe(
			'"odd names/ünïcödé \\"quoted\\".txt"'
		);
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
		const labels = rest.map((l) => /^([+-]\d+) /.exec(l)?.[1]).filter((l) => l !== undefined);
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
		expect(byLine).toBe(d.files.filter((f) => f.hasLines).length);
		expect(lineUnits).toBe(d.files.reduce((n, f) => n + (f.hasLines ? f.unitCount : 0), 0));
	};

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
