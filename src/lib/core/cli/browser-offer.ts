/**
 * How many browser windows one session of `diff-delver mcp` may open: one, for
 * the first report it creates. An agent may call `create_report` again and
 * again, over `HEAD~1`, `HEAD~2` and on; each later report's answer gives the
 * address and says why no window opened.
 *
 * The daemon keeps nothing about a session (it serves MCP without them, and a
 * restarted daemon would forget), so the shim keeps the count: only a message
 * that calls `create_report` asks, and says whether it may open a window
 * (`may-open`), whether one was opened for this session already
 * (`already-opened`), or neither (`not-asked`: with `--no-open`). One message
 * holds the offer at a time; another that would ask waits for its answer, so
 * when the first opened no window, because it failed or opened nothing new,
 * the offer is the next one's. The daemon's answer says when it opened one,
 * and from then on no message may.
 */

/** What a message tells the daemon about opening a browser window. */
export type BrowserAsk = 'may-open' | 'already-opened' | 'not-asked';

export class BrowserOffer {
	#state: 'offered' | 'lent' | 'used' | 'never';
	/** Settles when the message holding the offer has its answer. */
	#returned: Promise<void> = Promise.resolve();
	#giveBack: () => void = () => undefined;

	constructor(open: boolean) {
		this.#state = open ? 'offered' : 'never';
	}

	/**
	 * What a message that may open a window says; while another holds the
	 * offer, it waits for that one's answer first. The message that is told
	 * `may-open` holds the offer until it is settled.
	 */
	async lend(): Promise<BrowserAsk> {
		while (this.#state === 'lent') await this.#returned;
		switch (this.#state) {
			case 'offered':
				this.#state = 'lent';
				this.#returned = new Promise((resolve) => {
					this.#giveBack = resolve;
				});
				return 'may-open';
			case 'used':
				return 'already-opened';
			case 'never':
				return 'not-asked';
		}
	}

	/** The answer to a message that was lent the offer: whether the daemon opened a window. */
	settle(ask: BrowserAsk, opened: boolean): void {
		if (ask !== 'may-open') return;
		this.#state = opened ? 'used' : 'offered';
		this.#giveBack();
	}
}
