/**
 * How long ago something happened, in words, as a list shows it: "just now",
 * "5 minutes ago", "3 days ago". Measured from a `now` the caller passes in,
 * the daemon's clock, so it reads the same on the server and in the page and
 * does not depend on the timezone or the language of the machine.
 */
import { reviewerMessage, type ReviewerMessage } from './reviewer-message.tiny.ts';
import type { Timestamp } from './timestamp.tiny.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(count: number, unit: string): ReviewerMessage {
	return reviewerMessage(count === 1 ? `1 ${unit} ago` : `${String(count)} ${unit}s ago`);
}

export function describeTimeAgo(then: Timestamp, now: Timestamp): ReviewerMessage {
	const elapsed = now - then;
	if (elapsed < MINUTE) return reviewerMessage('just now');
	if (elapsed < HOUR) return ago(Math.floor(elapsed / MINUTE), 'minute');
	if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), 'hour');
	const days = Math.floor(elapsed / DAY);
	if (days < 30) return ago(days, 'day');
	if (days < 365) return ago(Math.floor(days / 30), 'month');
	return ago(Math.floor(days / 365), 'year');
}
