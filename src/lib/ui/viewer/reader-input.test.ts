/**
 * The reader's own input is told from the page's own scrolling, which fires
 * only `scroll` events, so keeping a match centred stops for the one and not
 * for the other.
 */
import { describe, expect, it } from 'vitest';
import { isPlainClick, READER_INPUT, whenReaderMoves } from './reader-input.ts';

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

	it('passes over input that is no moving away, and hears what comes after it', () => {
		const target = new EventTarget();
		let heard = 0;
		whenReaderMoves(
			target,
			() => {
				heard += 1;
			},
			(input) => input.type !== 'keydown'
		);
		target.dispatchEvent(new Event('keydown'));
		expect(heard).toBe(0);
		target.dispatchEvent(new Event('wheel'));
		expect(heard).toBe(1);
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

describe('telling a click that says where the reader is from one that selects text', () => {
	const plain = {
		button: 0,
		detail: 1,
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false
	};

	it('takes one plain click with nothing selected', () => {
		expect(isPlainClick(plain, false, false)).toBe(true);
	});

	it('leaves a drag, a double click, a selection put away and a modifier to the browser', () => {
		expect(isPlainClick(plain, false, true), 'a drag that selected text').toBe(false);
		expect(isPlainClick(plain, true, false), 'a click that put a selection away').toBe(false);
		expect(isPlainClick({ ...plain, detail: 2 }, false, false), 'a double click').toBe(false);
		expect(isPlainClick({ ...plain, detail: 3 }, false, false), 'a triple click').toBe(false);
		expect(isPlainClick({ ...plain, detail: 0 }, false, false), 'a key’s click').toBe(false);
		expect(isPlainClick({ ...plain, button: 2 }, false, false), 'another button').toBe(false);
		for (const key of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const) {
			expect(isPlainClick({ ...plain, [key]: true }, false, false), key).toBe(false);
		}
	});
});
