import { describe, expect, it } from 'vitest';
import { BrowserOffer } from './browser-offer.ts';

describe('one browser window for a session of the shim', () => {
	it('offers a window until the daemon says it opened one, then says one was opened', async () => {
		const offer = new BrowserOffer(true);
		const first = await offer.lend();
		expect(first).toBe('may-open');
		offer.settle(first, false);
		const second = await offer.lend();
		expect(second).toBe('may-open');
		offer.settle(second, true);
		for (let i = 0; i < 5; i += 1) {
			const later = await offer.lend();
			expect(later).toBe('already-opened');
			offer.settle(later, true);
		}
	});

	it('gives the offer to a message sent meanwhile when the one holding it opened no window', async () => {
		const offer = new BrowserOffer(true);
		const first = await offer.lend();
		let second: string | undefined;
		const waiting = offer.lend().then((ask) => {
			second = ask;
			return ask;
		});
		// A message sent while the first is unanswered waits for its answer.
		await Promise.resolve();
		expect(second).toBeUndefined();
		offer.settle(first, false);
		const ask = await waiting;
		expect(ask).toBe('may-open');
		// And once one opens a window, those waiting are told one was opened.
		const third = offer.lend();
		offer.settle(ask, true);
		expect(await third).toBe('already-opened');
	});

	it('never offers one with --no-open', async () => {
		const offer = new BrowserOffer(false);
		const ask = await offer.lend();
		expect(ask).toBe('not-asked');
		offer.settle(ask, true);
		expect(await offer.lend()).toBe('not-asked');
	});
});
