import { describe, expect, it } from 'vitest';
import { BrowserOffer } from './browser-offer.ts';

describe('one browser window for a session of the shim', () => {
	it('offers a window until the daemon says it opened one, then says one was opened', () => {
		const offer = new BrowserOffer(true);
		const first = offer.lend();
		expect(first).toBe('may-open');
		// A message sent while the first is unanswered does not offer one too.
		expect(offer.lend()).toBe('not-asked');
		offer.settle(first, false);
		const second = offer.lend();
		expect(second).toBe('may-open');
		offer.settle(second, true);
		for (let i = 0; i < 5; i += 1) {
			const later = offer.lend();
			expect(later).toBe('already-opened');
			offer.settle(later, true);
		}
	});

	it('never offers one with --no-open', () => {
		const offer = new BrowserOffer(false);
		const ask = offer.lend();
		expect(ask).toBe('not-asked');
		offer.settle(ask, true);
		expect(offer.lend()).toBe('not-asked');
	});
});
