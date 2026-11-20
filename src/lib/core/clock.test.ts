import { describe, expect, it } from 'vitest';
import { settableClock } from './clock.ts';
import { sequentialIds } from './ids.ts';
import { parseReportId } from './report-id.tiny.ts';
import { parseRevisionId } from './revision-id.tiny.ts';
import { nextRevisionNumber, parseRevisionNumber, FIRST_REVISION } from './revision-number.tiny.ts';
import { parseSectionTitle } from './section-title.tiny.ts';
import { millisecondsBetween, parseTimestamp, type Timestamp } from './timestamp.tiny.ts';
import { parseAgentMarkdown } from './agent-markdown.tiny.ts';

function at(ms: number): Timestamp {
	const parsed = parseTimestamp(ms);
	if (!parsed.ok) throw new Error('timestamp');
	return parsed.value;
}

describe('a settable clock', () => {
	it('says what it was set to, and moves only when told', () => {
		const clock = settableClock(at(1_000));
		expect(clock.now()).toBe(1_000);
		clock.advance(500);
		expect(clock.now()).toBe(1_500);
		clock.set(at(10));
		expect(clock.now()).toBe(10);
		expect(millisecondsBetween(at(10), at(1_500))).toBe(1_490);
	});

	it('refuses to move backwards or by a fraction', () => {
		const clock = settableClock(at(0));
		expect(() => {
			clock.advance(-1);
		}).toThrow(RangeError);
		expect(() => {
			clock.advance(0.5);
		}).toThrow(RangeError);
	});
});

describe('sequential ids', () => {
	it('count each kind separately and keep two sources apart by prefix', () => {
		const ids = sequentialIds();
		expect([ids.reportId(), ids.reportId(), ids.revisionId()]).toEqual(['r_1', 'r_2', 'v_1']);
		expect(sequentialIds('b').reportId()).toBe('r_b1');
	});
});

describe('the tiny types of reports', () => {
	it('accept what they should and refuse the rest', () => {
		expect(parseReportId('r_7f3').ok).toBe(true);
		for (const bad of ['', 'r_', 'v_1', 'r_ABC', `r_${'a'.repeat(33)}`]) {
			expect(parseReportId(bad).ok).toBe(false);
		}
		expect(parseRevisionId('v_1').ok).toBe(true);
		expect(parseRevisionId('r_1').ok).toBe(false);
		expect(parseRevisionNumber(0).ok).toBe(false);
		expect(parseRevisionNumber(1.5).ok).toBe(false);
		expect(nextRevisionNumber(FIRST_REVISION)).toBe(2);
		expect(parseTimestamp(-1).ok).toBe(false);
		expect(parseTimestamp(1.5).ok).toBe(false);
	});

	it('keep section titles to one well-formed line', () => {
		expect(parseSectionTitle('Session expiry').ok).toBe(true);
		const reasons = ['', ' ', 'a\nb', 'a b', 'x'.repeat(201), 'caf\uDCE9'].map((t) => {
			const parsed = parseSectionTitle(t);
			return parsed.ok ? 'ok' : parsed.error.reason;
		});
		expect(reasons).toEqual([
			'blank',
			'blank',
			'line-break',
			'line-break',
			'too-long',
			'malformed'
		]);
	});

	it('refuse agent Markdown with a lone surrogate, which could not be stored', () => {
		const parsed = parseAgentMarkdown('a \uD800 b');
		expect(parsed.ok ? 'ok' : parsed.error.reason).toBe('malformed');
	});
});
