/**
 * The next unread thing, with the agent's writing among it (DESIGN 8.1): the
 * overview, then each group's summary before its parts. A summary waits while
 * it is unread and something it introduces still waits, the overview while
 * anything does, so finishing a section by its tick never leaves its summary
 * behind to read, and nothing waits once everything is reviewed.
 *
 * Groups are the page's, in reading order, each a run of parts; a group with
 * a summary names it by `summary`, the same for a section and its Tests
 * group, which show the same summary, so reading one reads both and it is
 * counted once.
 */
import { partIndexOf, type PartIndex } from '../part-index.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { nextWaiting } from './reading-order.ts';
import { countOf, describeChanges } from './words.ts';

/** Where the reader can be: the overview, a group's summary, or a part. */
export type ReadingPlace = WritingPlace | { readonly kind: 'part'; readonly at: PartIndex };

/** The agent's writing as a place to read: its overview, or a group's summary. */
export type WritingPlace =
	{ readonly kind: 'overview' } | { readonly kind: 'summary'; readonly group: number };

export interface GroupToRead {
	/** Its parts' places in reading order: `first` to `first + count - 1`. */
	readonly first: number;
	readonly count: number;
	/** The summary it shows, by what names it, when it has one not read yet. */
	readonly unreadSummary: string | undefined;
}

export interface ToRead {
	/** Whether the agent wrote an overview the reader has not read. */
	readonly overviewUnread: boolean;
	readonly groups: readonly GroupToRead[];
	/** Whether each part still waits, in reading order. */
	readonly waiting: readonly boolean[];
}

interface Stop {
	readonly place: ReadingPlace;
	readonly waits: boolean;
}

function stops(toRead: ToRead): Stop[] {
	const { waiting } = toRead;
	const any = waiting.includes(true);
	const list: Stop[] = [{ place: { kind: 'overview' }, waits: toRead.overviewUnread && any }];
	for (const [index, group] of toRead.groups.entries()) {
		const parts = waiting.slice(group.first, group.first + group.count);
		list.push({
			place: { kind: 'summary', group: index },
			waits: group.unreadSummary !== undefined && parts.includes(true)
		});
		for (let at = group.first; at < group.first + group.count; at += 1) {
			list.push({ place: { kind: 'part', at: partIndexOf(at) }, waits: waiting[at] === true });
		}
	}
	return list;
}

function samePlace(a: ReadingPlace, b: ReadingPlace): boolean {
	switch (a.kind) {
		case 'overview':
			return b.kind === 'overview';
		case 'summary':
			return b.kind === 'summary' && b.group === a.group;
		case 'part':
			return b.kind === 'part' && b.at === a.at;
	}
}

/**
 * The next place after `from` that waits, going round past the end to the
 * top, as `nextWaiting` does; with `from` undefined, the first. Undefined
 * when nothing waits.
 */
export function nextUnreadPlace(toRead: ToRead, from?: ReadingPlace): ReadingPlace | undefined {
	const list = stops(toRead);
	const at = from === undefined ? -1 : list.findIndex((stop) => samePlace(stop.place, from));
	const next = nextWaiting(
		list.map((stop) => stop.waits),
		at < 0 ? undefined : partIndexOf(at)
	);
	return next === undefined ? undefined : list[next]?.place;
}

/** What is left of the agent's writing: whether the overview, and how many summaries, counted once each. */
export function summariesLeft(toRead: ToRead): { overview: boolean; summaries: number } {
	const list = stops(toRead);
	const names = new Set<string>();
	for (const stop of list) {
		if (stop.place.kind !== 'summary' || !stop.waits) continue;
		const name = toRead.groups[stop.place.group]?.unreadSummary;
		if (name !== undefined) names.add(name);
	}
	return { overview: list[0]?.waits === true, summaries: names.size };
}

/**
 * What is left to read, with the agent's writing apart from the changes:
 * "Left to read: 12 changes, the agent’s overview and 2 section summaries".
 * Undefined when none of the agent's writing is left, since the changes
 * alone are said by the progress.
 */
export function describeLeftToRead(
	changes: number,
	left: { overview: boolean; summaries: number }
): ReviewerMessage | undefined {
	const writing = [
		...(left.overview ? ['the agent’s overview'] : []),
		...(left.summaries > 0 ? [countOf(left.summaries, 'section summary', 'section summaries')] : [])
	];
	if (writing.length === 0) return undefined;
	const items = [...(changes > 0 ? [describeChanges(changes)] : []), ...writing];
	const last = items.pop() ?? '';
	const listed = items.length === 0 ? last : `${items.join(', ')} and ${last}`;
	return reviewerMessage(`Left to read: ${listed}`);
}
