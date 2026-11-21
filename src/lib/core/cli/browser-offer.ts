/**
 * How many browser windows one session of `diff-delver mcp` may open: one, for
 * the first report it creates. An agent may call `create_report` again and
 * again, over `HEAD~1`, `HEAD~2` and on; each later report's answer gives the
 * address and says why no window opened.
 *
 * The daemon keeps nothing about a session (it serves MCP without them, and a
 * restarted daemon would forget), so the shim keeps the count: each message
 * says whether it may open a window (`may-open`), whether one was opened for
 * this session already (`already-opened`), or neither (`not-asked`: with
 * `--no-open`, or while another message holds the offer). The daemon's answer
 * says when it opened one, and from then on no message may.
 */

/** What a message tells the daemon about opening a browser window. */
export type BrowserAsk = 'may-open' | 'already-opened' | 'not-asked';

export class BrowserOffer {
	#state: 'offered' | 'lent' | 'used' | 'never';

	constructor(open: boolean) {
		this.#state = open ? 'offered' : 'never';
	}

	/** What the next message says; a message that may open holds the offer until it is answered. */
	lend(): BrowserAsk {
		switch (this.#state) {
			case 'offered':
				this.#state = 'lent';
				return 'may-open';
			case 'used':
				return 'already-opened';
			case 'lent':
			case 'never':
				return 'not-asked';
		}
	}

	/** The answer to a message that held the offer: whether the daemon opened a window. */
	settle(ask: BrowserAsk, opened: boolean): void {
		if (ask !== 'may-open') return;
		this.#state = opened ? 'used' : 'offered';
	}
}
