import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	quietWhiteSpace,
	withoutWhiteSpace,
	type LineForWhiteSpace,
	type Quieted
} from './white-space.ts';

interface Line extends LineForWhiteSpace {
	readonly id: number;
}

let next = 0;
const line = (kind: Line['kind'], text: string, group = 'here'): Line => ({
	id: (next += 1),
	kind,
	text,
	group
});
const context = (text: string) => line('context', text);
const removed = (text: string, group?: string) => line('deleted', text, group);
const added = (text: string, group?: string) => line('added', text, group);
const view = (l: Line): LineForWhiteSpace => l;

/** What is drawn: `=text` unchanged, `~old|new` white space only, `-text`, `+text`. */
function drawn(out: readonly Quieted<Line>[]): string[] {
	return out.map((q) => {
		if (q.kind === 'quiet') return `~${q.removed.text}|${q.added.text}`;
		const sign = q.line.kind === 'context' ? '=' : q.line.kind === 'deleted' ? '-' : '+';
		return `${sign}${q.line.text}`;
	});
}

describe('changes that only change white space', () => {
	it('takes out spaces, tabs, carriage returns, form feeds and vertical tabs, and nothing else', () => {
		expect(withoutWhiteSpace(' \ta b\r\f\v')).toBe('ab');
		expect(withoutWhiteSpace('a b​c')).toBe('a b​c');
	});

	it('draws a re-indented block as unchanged lines, line for line', () => {
		expect(
			drawn(
				quietWhiteSpace(
					[
						context('if (x) {'),
						removed('call(a);'),
						removed('call(b);'),
						added('\tcall(a);'),
						added('\tcall(b);'),
						context('}')
					],
					view
				)
			)
		).toEqual(['=if (x) {', '~call(a);|\tcall(a);', '~call(b);|\tcall(b);', '=}']);
	});

	it('hides white space at the end, inside a string and a changed line ending', () => {
		expect(
			drawn(
				quietWhiteSpace(
					[
						removed('a = 1;'),
						removed("s = 'x y';"),
						removed('b'),
						added('a = 1;  '),
						added("s = 'x  y';"),
						added('b\r')
					],
					view
				)
			)
		).toEqual(['~a = 1;|a = 1;  ', "~s = 'x y';|s = 'x  y';", '~b|b\r']);
	});

	it('keeps a real change, and a blank line added on its own, as changes', () => {
		expect(
			drawn(
				quietWhiteSpace(
					[removed('a(1);'), removed('b();'), added('a(2);'), added(''), added('  b();')],
					view
				)
			)
		).toEqual(['-a(1);', '+a(2);', '+', '~b();|  b();']);
	});

	it('never matches a change of one group with a change of another', () => {
		expect(drawn(quietWhiteSpace([removed('a', 'here'), added(' a', 'auth')], view))).toEqual([
			'-a',
			'+ a'
		]);
	});

	it('draws every line once, keeps each side in order, and pairs only what matches', () => {
		const texts = fc.constantFrom('a', ' a', 'a ', 'b', '\tb', '', ' ');
		const arbitraryLine = fc.tuple(
			fc.constantFrom<Line['kind']>('context', 'deleted', 'added'),
			texts,
			fc.constantFrom('here', 'other')
		);
		fc.assert(
			fc.property(fc.array(arbitraryLine, { maxLength: 40 }), (made) => {
				const lines = made.map(([kind, text, group], id): Line => ({ id, kind, text, group }));
				const out = quietWhiteSpace(lines, view);
				const flat = out.flatMap((q) => (q.kind === 'line' ? [q.line] : [q.removed, q.added]));
				expect(flat.map((l) => l.id).sort((x, y) => x - y)).toEqual(lines.map((l) => l.id));
				const sideOrder = (kind: Line['kind']) =>
					flat.filter((l) => l.kind !== kind).map((l) => l.id);
				expect(sideOrder('added')).toEqual([...sideOrder('added')].sort((x, y) => x - y));
				expect(sideOrder('deleted')).toEqual([...sideOrder('deleted')].sort((x, y) => x - y));
				for (const q of out) {
					if (q.kind !== 'quiet') continue;
					expect(q.removed.kind).toBe('deleted');
					expect(q.added.kind).toBe('added');
					expect(q.removed.group).toBe(q.added.group);
					expect(withoutWhiteSpace(q.removed.text)).toBe(withoutWhiteSpace(q.added.text));
				}
				// With nothing to hide, the lines are drawn as they are.
				const plain = lines.map((l): Line => ({ ...l, text: `${String(l.id)}x` }));
				expect(quietWhiteSpace(plain, view)).toEqual(plain.map((l) => ({ kind: 'line', line: l })));
			})
		);
	});
});
