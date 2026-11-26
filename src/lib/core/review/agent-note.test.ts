import { describe, expect, it } from 'vitest';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { renderNotesAdded } from '../agent/notes-answer.ts';
import { parseAgentMarkdown } from '../agent-markdown.tiny.ts';
import { parseReportId } from '../report-id.tiny.ts';
import { parseRevisionNumber } from '../revision-number.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import {
	describeEarlierNotes,
	describeNoteProblem,
	MAX_NOTE_LENGTH,
	promotedNoteBody,
	resolveNoteRequests,
	sameNote,
	type NoteRequest
} from './agent-note.ts';

// New lines 11 to 13 added between unchanged lines 10 and 14; old line 18 removed.
const diff = syntheticDiff([
	{ path: 'a.png', change: 'binary' },
	{
		path: 'src/b.ts',
		change: 'modified',
		hunks: [
			{ gap: 9, lines: [' ', '+', '+', '+', ' '] },
			{ gap: 5, lines: [' ', '-', ' '] }
		]
	}
]);

function parseRevisionNumberOrThrow(n: number) {
	const parsed = parseRevisionNumber(n);
	if (!parsed.ok) throw new Error('not a version');
	return parsed.value;
}

function note(lines: string, more: Partial<NoteRequest> = {}): NoteRequest {
	return { label: 'risk', file: 'src/b.ts', lines, text: 'Look here.', ...more };
}

function resolved(requests: readonly NoteRequest[]) {
	const result = resolveNoteRequests(diff, requests);
	if (!result.ok) throw new Error(result.error.map(describeNoteProblem).join(' '));
	return result.value;
}

function problems(requests: readonly NoteRequest[]): string[] {
	const result = resolveNoteRequests(diff, requests);
	if (result.ok) throw new Error('accepted');
	return result.error.map(describeNoteProblem);
}

describe('checking agent notes against the diff', () => {
	it('narrows a range to the change lines inside it, on its side', () => {
		const [first, second] = resolved([note('+9..+20'), note('-18', { label: 'question' })]);
		expect(first?.anchor).toEqual({ path: 'src/b.ts', side: 'new', first: 11, last: 13 });
		expect(second?.anchor).toEqual({ path: 'src/b.ts', side: 'old', first: 18, last: 18 });
		expect(second?.label).toBe('question');
	});

	it('refuses the whole call, naming each note that is wrong and why', () => {
		const said = problems([
			note('+11'),
			note('+1..+5'),
			note('+11,+13'),
			note('+11', { file: 'src/c.ts' }),
			note('file', { file: 'a.png' }),
			note('+11', { text: '   ' }),
			note('+11', { text: 'x'.repeat(MAX_NOTE_LENGTH + 1) })
		]);
		expect(said).toHaveLength(6);
		expect(said[0]).toMatch(/^Note 1: .*no changed line/i);
		expect(said[1]).toMatch(/^Note 2: "lines" must be one range on one side/);
		expect(said[2]).toMatch(/^Note 3: .*not a changed file/);
		expect(said[3]).toMatch(/^Note 4: "lines" must be one range/);
		expect(said[4]).toMatch(/^Note 5: the text is blank/);
		expect(said[5]).toMatch(/^Note 6: the text is longer than 2000 characters/);
	});

	it('tells a note sent again from a different one', () => {
		const [a, b] = resolved([note('+11'), note('+11', { label: 'info' })]);
		if (a === undefined || b === undefined) throw new Error('missing');
		expect(sameNote(a, a)).toBe(true);
		expect(sameNote(a, b)).toBe(false);
	});
});

describe('notes on an earlier version', () => {
	it('are named with their version, since notes are not carried over', () => {
		expect(describeEarlierNotes({ version: parseRevisionNumberOrThrow(1), waiting: 3 })).toBe(
			'The agent left 3 notes on version 1; notes stay with the version they were written on.'
		);
	});
});

describe('a promoted note', () => {
	it('quotes the agent and says where the words came from', () => {
		const text = parseAgentMarkdown('Seconds here.\n\nMilliseconds at +41.');
		if (!text.ok) throw new Error('blank');
		expect(promotedNoteBody({ label: 'possible bug', text: text.value })).toBe(
			'From an agent note (possible bug):\n> Seconds here.\n>\n> Milliseconds at +41.'
		);
	});
});

describe('what add_notes answers', () => {
	const id = parseReportId('r_00000001');
	const version = parseRevisionNumber(2);
	if (!id.ok || !version.ok) throw new Error('bad fixture');
	const heading = {
		id: id.value,
		title: reviewerMessage('Uncommitted changes'),
		repository: reviewerMessage('shop'),
		version: version.value
	};

	it('says what was added, passed over and replaced, and how to replace them', () => {
		const text = renderNotesAdded(heading, {
			added: 2,
			repeated: 1,
			removed: 3,
			total: 4,
			actedOn: 1
		});
		expect(text).toContain('Report r_00000001: Uncommitted changes in shop, version 2.');
		expect(text).toContain(
			'Removed 3 earlier notes the person had not acted on. Added 2 notes. 1 note was on version 2 already'
		);
		expect(text).toContain(
			'Version 2 holds 4 notes now; the person has dismissed or promoted 1 of them.'
		);
		expect(text).toContain('"replace": true');
	});
});
