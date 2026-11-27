/**
 * What a Delve takes on disk, in words (DESIGN 8.5, 9.1): "About 40 MB on
 * disk" on the list, with what it shares on hover, and "frees about 40 MB" in
 * the confirmation before deleting it. The figures are estimates, so they are
 * always said with "about"; a store's and the database's sizes on disk are
 * exact and are not.
 */
import type { ByteSize } from '../byte-size.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { describeTimeAgo } from '../time-ago.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { describeByteSize } from '../viewer/words.ts';
import type { DelveDiskUsage } from './delve-sizes.ts';

/** A size small enough to say as "almost nothing": under a kilobyte. */
const ALMOST_NOTHING = 1024;

function about(size: DelveDiskUsage['own']): string {
	return `about ${describeByteSize(size)}`;
}

/** A Delve's own figure, as the list shows it: "About 40 MB on disk". */
export function describeDiskUsage(usage: DelveDiskUsage): ReviewerMessage {
	if (usage.own < ALMOST_NOTHING) {
		return reviewerMessage(
			usage.shared < ALMOST_NOTHING ? 'Almost nothing on disk' : 'Almost nothing on disk of its own'
		);
	}
	return reviewerMessage(`About ${describeByteSize(usage.own)} on disk`);
}

/**
 * Both figures in a sentence, for hovering over the list's: "Deleting it frees
 * about 40 MB. About 2 MB more is shared with other Delves of this repository."
 */
export function describeDiskUsageInFull(usage: DelveDiskUsage): ReviewerMessage {
	const frees =
		usage.own < ALMOST_NOTHING
			? 'Deleting it frees almost nothing.'
			: `Deleting it frees ${about(usage.own)}.`;
	if (usage.shared < ALMOST_NOTHING) return reviewerMessage(frees);
	return reviewerMessage(
		`${frees} About ${describeByteSize(usage.shared)} more is shared with other Delves of this repository, and stays.`
	);
}

/**
 * What deleting a Delve frees, for the confirmation: "Deleting it frees about
 * 40 MB on disk within an hour." The store keeps what nothing uses for an
 * hour through a collection, so the space comes back then; not yet measured,
 * only when.
 */
export function describeWhatDeletingFrees(usage: DelveDiskUsage | undefined): ReviewerMessage {
	if (usage === undefined) {
		return reviewerMessage('The space it takes on disk is freed within an hour.');
	}
	if (usage.own < ALMOST_NOTHING) {
		return reviewerMessage(
			usage.shared < ALMOST_NOTHING
				? 'It takes almost no space on disk.'
				: 'It frees almost no space on disk: what it holds is shared with other Delves of this repository.'
		);
	}
	return reviewerMessage(`Deleting it frees ${about(usage.own)} on disk within an hour.`);
}

/**
 * A store's or the database's size on disk, which is exact, with when it was
 * measured: "12 MB on disk, measured 5 minutes ago", or "Not measured yet".
 */
export function describeMeasuredSize(
	size: { readonly onDisk: ByteSize; readonly measuredAt: Timestamp } | undefined,
	now: Timestamp
): ReviewerMessage {
	if (size === undefined) return reviewerMessage('Not measured yet');
	return reviewerMessage(
		`${describeByteSize(size.onDisk)} on disk, measured ${describeTimeAgo(size.measuredAt, now)}`
	);
}
