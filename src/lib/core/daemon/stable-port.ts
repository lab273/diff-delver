/**
 * The port a daemon listens on (DESIGN 3). The daemon of the machine's default
 * data folder listens at the same address every time, `127.0.0.1:12321`
 * (`STABLE_PORT`), so a page left open across a restart, or a replacement by
 * another version, reaches the new daemon where it found the old one. A
 * daemon of any other data folder takes a free port, as tests, journeys and
 * agent trials do, so it never takes the stable port from the person's own.
 *
 * When something else already listens on the stable port, the daemon does not
 * fail: it takes a free port and says so once (`describeStablePortTaken`).
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import { parsePortNumber, type PortNumber } from '../port-number.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';

function port(value: number): PortNumber {
	const parsed = parsePortNumber(value);
	if (!parsed.ok) throw new Error(`${String(value)} is not a port.`);
	return parsed.value;
}

/** Where the daemon of the machine's default data folder listens. */
export const STABLE_PORT: PortNumber = port(12321);

/** The port a daemon of `dataDirectory` tries first, or undefined for any free one. */
export function preferredPortFor(
	dataDirectory: AbsolutePath,
	machineDefault: AbsolutePath | undefined
): PortNumber | undefined {
	return dataDirectory === machineDefault ? STABLE_PORT : undefined;
}

/** Why a daemon could not listen on its preferred port. */
export type PortNotHad =
	/** Something else listens there, perhaps an older diff delver still stopping. */
	| { readonly kind: 'in-use' }
	/** The system refused for another reason, in its own words. */
	| { readonly kind: 'refused'; readonly detail: ReviewerMessage };

/**
 * What a daemon says, once, when it could not listen on its preferred port and
 * listens on another, with why.
 */
export function describeStablePortTaken(
	preferred: PortNumber,
	taken: PortNumber,
	why: PortNotHad
): ReviewerMessage {
	const usual = `diff delver usually listens at http://127.0.0.1:${String(preferred)}`;
	const now = `so it is at http://127.0.0.1:${String(taken)}. Pages opened before it started cannot find it there; run diff-delver to open them again.`;
	switch (why.kind) {
		case 'in-use':
			return reviewerMessage(
				`${usual}, but something else was using that port, perhaps an earlier diff delver still stopping, ${now} To have the usual address back, stop whatever uses port ${String(preferred)}, then run diff-delver stop and diff-delver.`
			);
		case 'refused':
			return reviewerMessage(
				`${usual}, but the system would not let it listen there (${why.detail}), ${now}`
			);
		default: {
			const unknown: never = why;
			return unknown;
		}
	}
}
