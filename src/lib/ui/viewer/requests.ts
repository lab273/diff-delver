/**
 * How many parts' lines the viewer fetches at once, at most. More wait their
 * turn, so no action, such as unticking a whole group of 2,000 files, can send
 * the daemon (or the browser) more than it can take. Its own module, with
 * nothing imported, so the speed test can check the page keeps to it.
 */
export const PART_REQUESTS_AT_ONCE = 6;

/**
 * How many requests for colours the viewer has under way at once, at most.
 * Each also waits until no part's lines are being fetched, so colouring never
 * holds up the lines of a part coming into view: code is shown plain first and
 * coloured when its colours come.
 */
export const COLOUR_REQUESTS_AT_ONCE = 2;

/** Turns for requests, at most `limit` under way at once; the rest wait, in order. */
export class Turns {
	#under = 0;
	readonly #waiting: (() => void)[] = [];
	readonly #limit: number;

	constructor(limit: number) {
		this.#limit = limit;
	}

	readonly #idle: (() => void)[] = [];

	/** Waits for a turn; the function it gives ends the turn. */
	async take(): Promise<() => void> {
		if (this.#under >= this.#limit) {
			await new Promise<void>((resolve) => {
				this.#waiting.push(resolve);
			});
		}
		this.#under += 1;
		return () => {
			this.#under -= 1;
			this.#waiting.shift()?.();
			if (this.#under === 0) for (const resolve of this.#idle.splice(0)) resolve();
		};
	}

	/** Waits until no request is under way or waiting, so other work can wait its turn behind them. */
	async idle(): Promise<void> {
		while (this.#under > 0) {
			await new Promise<void>((resolve) => {
				this.#idle.push(resolve);
			});
		}
	}
}

/** Which lines of each side of each part have been asked about, so none is asked about twice. */
export class AskedLines {
	readonly #asked = new Map<number, { readonly old: Set<number>; readonly new: Set<number> }>();

	/** Of these lines of a part, those not asked about yet, now counted as asked. */
	ask(
		part: number,
		old: readonly number[],
		now: readonly number[]
	): { readonly old: number[]; readonly new: number[] } {
		let asked = this.#asked.get(part);
		if (asked === undefined) {
			asked = { old: new Set(), new: new Set() };
			this.#asked.set(part, asked);
		}
		const { old: askedOld, new: askedNew } = asked;
		const freshOld = old.filter((n) => !askedOld.has(n));
		const freshNew = now.filter((n) => !askedNew.has(n));
		for (const n of freshOld) askedOld.add(n);
		for (const n of freshNew) askedNew.add(n);
		return { old: freshOld, new: freshNew };
	}
}
