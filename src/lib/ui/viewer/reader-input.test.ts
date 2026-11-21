/**
 * The reader's own input is told from the page's own scrolling, which fires
 * only `scroll` events, so keeping a match centred stops for the one and not
 * for the other.
 */
import { describe, expect, it } from 'vitest';
import { READER_INPUT, whenReaderMoves } from './reader-input.ts';

describe('telling the reader’s moving of the page from the page’s', () => {
	it('hears each kind of the reader’s input once, and never the page’s own scrolling', () => {
		for (const type of READER_INPUT) {
			const target = new EventTarget();
			let heard = 0;
			whenReaderMoves(target, () => {
				heard += 1;
			});
			target.dispatchEvent(new Event('scroll'));
			expect(heard, type).toBe(0);
			target.dispatchEvent(new Event(type));
			target.dispatchEvent(new Event(type));
			expect(heard, type).toBe(1);
		}
	});

	it('hears nothing once it stops listening', () => {
		const target = new EventTarget();
		let heard = 0;
		const stop = whenReaderMoves(target, () => {
			heard += 1;
		});
		stop();
		target.dispatchEvent(new Event('wheel'));
		expect(heard).toBe(0);
	});
});
