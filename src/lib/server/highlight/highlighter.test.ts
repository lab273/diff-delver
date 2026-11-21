/**
 * Colouring whole files with the bundled grammars: what is inside a comment or
 * a string that opened many lines before is coloured as such, however the
 * work was sliced, and a CRLF file is coloured as any other.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '#lib/core/highlight/language.ts';
import { parseLineText, type LineText } from '#lib/core/line-text.tiny.ts';
import { colourLines } from './highlighter.ts';

function linesOf(...texts: string[]): readonly LineText[] {
	return texts.map((text) => {
		const parsed = parseLineText(text);
		if (!parsed.ok) throw new Error(text);
		return parsed.value;
	});
}

describe('colouring a whole file', () => {
	it('keeps what a comment or a string opened, thousands of lines on', async () => {
		const inside = Array.from({ length: 3_000 }, (_, i) => `still inside ${String(i)}`);
		const coloured = await colourLines(
			linesOf('/*', ...inside, '*/', 'const a = `', ...inside, '`;', 'let b = 1;'),
			'typescript'
		);
		expect(coloured[2_500]).toEqual([{ start: 0, length: 17, kind: 'comment' }]);
		expect(coloured[3_002 + 2_900]?.map((r) => r.kind)).toEqual(['string']);
		expect(coloured.at(-1)?.map((r) => r.kind)).toContain('keyword');
		expect(coloured).toHaveLength(6_005);
	});

	it('colours a line the same with a CRLF ending as without', async () => {
		const plain = await colourLines(linesOf('const a = "x";'), 'typescript');
		const crlf = await colourLines(linesOf('const a = "x";\r'), 'typescript');
		expect(crlf).toEqual(plain);
	});

	it('has a grammar for every language it names', async () => {
		for (const language of LANGUAGES) {
			expect(await colourLines(linesOf('x'), language)).toHaveLength(1);
		}
	});
});
