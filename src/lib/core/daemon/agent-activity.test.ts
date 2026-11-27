import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../absolute-path.tiny.ts';
import { settableClock } from '../clock.ts';
import { parseReportId, type ReportId } from '../report-id.tiny.ts';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';
import {
	AGENT_ACTIVITY_KEPT,
	agentActivity,
	agentListening,
	LISTENING_LINGERS_MS,
	describeAgentHeard,
	describeAgentWorked,
	isInFolder
} from './agent-activity.ts';

function time(value: number): Timestamp {
	const parsed = parseTimestamp(value);
	if (!parsed.ok) throw new Error('not a time');
	return parsed.value;
}

function folder(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error('not a path');
	return parsed.value;
}

function report(id: string): ReportId {
	const parsed = parseReportId(id);
	if (!parsed.ok) throw new Error('not a report id');
	return parsed.value;
}

const MINUTE = 60_000;

describe('the agents a daemon has heard from', () => {
	it('knows of none until one sends a message', () => {
		const activity = agentActivity(settableClock(time(1_000)));
		expect(activity.lastHeard(folder('/work/shop'))).toBeUndefined();
		expect(activity.lastWorked(report('r_1'))).toBeUndefined();
	});

	it('tells of the agent started in the repository before a later one started elsewhere', () => {
		const clock = settableClock(time(1_000));
		const activity = agentActivity(clock);
		activity.heard(folder('/work/shop/src'));
		clock.advance(MINUTE);
		activity.heard(folder('/work/other'));
		expect(activity.lastHeard(folder('/work/shop'))).toEqual({
			directory: '/work/shop/src',
			real: '/work/shop/src',
			at: time(1_000)
		});
		expect(activity.lastHeard(folder('/work/third'))).toEqual({
			directory: '/work/other',
			real: '/work/other',
			at: time(1_000 + MINUTE)
		});
	});

	it('remembers a client that named no folder, as one started nowhere it knows', () => {
		const activity = agentActivity(settableClock(time(1_000)));
		activity.heard(undefined);
		expect(activity.lastHeard(folder('/work/shop'))).toEqual({
			directory: null,
			real: null,
			at: time(1_000)
		});
	});

	it('finds the agent started in the repository through a link to it, and says the link', () => {
		const clock = settableClock(time(1_000));
		const activity = agentActivity(clock);
		activity.heard(folder('/home/me/shop-link/src'), folder('/work/shop/src'));
		clock.advance(MINUTE);
		activity.heard(folder('/work/other'));
		expect(activity.lastHeard(folder('/work/shop'))).toEqual({
			directory: '/home/me/shop-link/src',
			real: '/work/shop/src',
			at: time(1_000)
		});
	});

	it('keeps the latest time for a folder and for a report', () => {
		const clock = settableClock(time(1_000));
		const activity = agentActivity(clock);
		activity.heard(folder('/work/shop'));
		activity.worked(report('r_1'));
		clock.advance(5 * MINUTE);
		activity.heard(folder('/work/shop'));
		activity.worked(report('r_1'));
		expect(activity.lastHeard(folder('/work/shop'))?.at).toBe(time(1_000 + 5 * MINUTE));
		expect(activity.lastWorked(report('r_1'))).toBe(time(1_000 + 5 * MINUTE));
		expect(activity.lastWorked(report('r_2'))).toBeUndefined();
	});

	it('forgets what it heard of longest ago, so it never grows without bound', () => {
		const clock = settableClock(time(1_000));
		const activity = agentActivity(clock);
		for (let n = 0; n <= AGENT_ACTIVITY_KEPT; n += 1) {
			activity.heard(folder(`/work/repo${String(n)}`));
			activity.worked(report(`r_${String(n)}`));
			clock.advance(1);
		}
		expect(activity.lastWorked(report('r_0'))).toBeUndefined();
		expect(activity.lastWorked(report('r_1'))).toBe(time(1_001));
		expect(activity.lastHeard(folder('/work/repo0'))?.directory).toBe(
			`/work/repo${String(AGENT_ACTIVITY_KEPT)}`
		);
		expect(activity.lastHeard(folder('/work/repo1'))?.directory).toBe('/work/repo1');
	});
});

describe('a folder inside another', () => {
	it('is the folder itself or one under it, never one whose name only starts the same', () => {
		expect(isInFolder(folder('/work/shop'), folder('/work/shop'))).toBe(true);
		expect(isInFolder(folder('/work/shop/src/lib'), folder('/work/shop'))).toBe(true);
		expect(isInFolder(folder('/work/shop'), folder('/work/shop/'))).toBe(true);
		expect(isInFolder(folder('/work/shop-two'), folder('/work/shop'))).toBe(false);
		expect(isInFolder(folder('/work'), folder('/work/shop'))).toBe(false);
		expect(isInFolder(null, folder('/work/shop'))).toBe(false);
	});
});

describe('what the page says of an agent', () => {
	const home = folder('/home/reviewer');

	it('says when it connected and where it was started, as something that happened', () => {
		expect(
			describeAgentHeard(
				{ directory: folder('/home/reviewer/src/shop'), at: time(1_000) },
				time(2_000),
				home
			)
		).toBe('An agent connected to this diff delver a moment ago, started in ~/src/shop.');
		expect(
			describeAgentHeard(
				{ directory: folder('/srv/shop'), at: time(1_000) },
				time(1_000 + 12 * MINUTE),
				home
			)
		).toBe('An agent connected to this diff delver 12 minutes ago, started in /srv/shop.');
	});

	it('names no folder for a client that gave none', () => {
		expect(
			describeAgentHeard({ directory: null, at: time(1_000) }, time(1_000 + 3 * 60 * MINUTE), home)
		).toBe('An agent connected to this diff delver 3 hours ago.');
	});

	it('says when an agent last worked on a Delve', () => {
		expect(describeAgentWorked(time(1_000), time(1_500))).toBe(
			'An agent last worked on this Delve a moment ago.'
		);
		expect(describeAgentWorked(time(1_000), time(1_000 + 2 * MINUTE))).toBe(
			'An agent last worked on this Delve 2 minutes ago.'
		);
	});
});

describe('which Delves an agent is listening to', () => {
	it('counts an open wait, and one that ended a moment ago, as connected', () => {
		const clock = settableClock(time(1_000));
		const listening = agentListening(clock);
		const shop = report('r_1');
		expect(listening.listening(shop)).toBe(false);
		listening.began(shop);
		listening.began(shop);
		clock.advance(10 * MINUTE);
		expect(listening.listening(shop)).toBe(true);
		listening.ended(shop);
		expect(listening.listening(shop)).toBe(true);
		listening.ended(shop);
		clock.advance(LISTENING_LINGERS_MS - 1);
		expect(listening.listening(shop)).toBe(true);
		expect(listening.listening(report('r_2'))).toBe(false);
		clock.advance(1);
		expect(listening.listening(shop)).toBe(false);
	});
});
