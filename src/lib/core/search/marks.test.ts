import { describe, expect, it } from 'vitest';
import { markedRuns, withMarks, type PieceShape } from './marks.ts';

type Piece = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'escape' };

const shape: PieceShape<Piece> = {
	size: (p) => (p.kind === 'text' ? p.text.length : 1),
	cut: (p, from, to) =>
		p.kind === 'text' ? { kind: 'text', text: p.text.slice(from, to) } : undefined
};

describe('marking matches on pieces', () => {
	it('cuts text where a match starts and ends', () => {
		const marked = withMarks<Piece>(
			[{ kind: 'text', text: 'const total = 1' }],
			[{ start: 6, length: 5, current: true }],
			shape
		);
		expect(marked).toEqual([
			{ piece: { kind: 'text', text: 'const ' }, mark: undefined },
			{ piece: { kind: 'text', text: 'total' }, mark: 'current' },
			{ piece: { kind: 'text', text: ' = 1' }, mark: undefined }
		]);
	});

	it('marks a match across pieces, and a piece that cannot be cut as a whole', () => {
		const marked = withMarks<Piece>(
			[{ kind: 'text', text: 'ab' }, { kind: 'escape' }, { kind: 'text', text: 'cd' }],
			[
				{ start: 1, length: 3, current: false },
				{ start: 4, length: 1, current: true }
			],
			shape
		);
		expect(marked).toEqual([
			{ piece: { kind: 'text', text: 'a' }, mark: undefined },
			{ piece: { kind: 'text', text: 'b' }, mark: 'match' },
			{ piece: { kind: 'escape' }, mark: 'match' },
			{ piece: { kind: 'text', text: 'c' }, mark: 'match' },
			{ piece: { kind: 'text', text: 'd' }, mark: 'current' }
		]);
	});

	it('leaves pieces whole with no marks', () => {
		const pieces: Piece[] = [{ kind: 'text', text: 'x' }, { kind: 'escape' }];
		expect(withMarks(pieces, [], shape).map((m) => m.piece)).toEqual(pieces);
	});

	it('gathers pieces of one mark into one run, so a match cut by colours is one mark', () => {
		const runs = markedRuns<string>([
			{ piece: 'a', mark: undefined },
			{ piece: 'Math', mark: 'current' },
			{ piece: '.round', mark: 'current' },
			{ piece: 'b', mark: 'match' }
		]);
		expect(runs).toEqual([
			{ pieces: ['a'], mark: undefined },
			{ pieces: ['Math', '.round'], mark: 'current' },
			{ pieces: ['b'], mark: 'match' }
		]);
	});
});
