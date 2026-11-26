/**
 * Agent notes (DESIGN 5, `note`): the agent pointing at something specific on
 * a run of changed lines, with a label and a few words. They are secondary to
 * the reviewer's own reading: never the reviewer's words, never in a finished
 * review, and each one waits until the reviewer dismisses it or promotes it,
 * which copies it into the draft as a comment of their own that says where it
 * came from. Pure: the labels, the bounds, checking what `add_notes` sent
 * against the diff, and the words of a promoted note.
 *
 * A note belongs to the version it was written on, as a comment does, and is
 * drawn at its lines only on that version: it is the agent's reading of that
 * code, which a later version may have changed.
 */
import { parseAgentMarkdown, type AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { AgentNoteId } from '../agent-note-id.tiny.ts';
import { describeRejection, resolveUnits, type AssignRejection } from '../diff/assign.ts';
import type { Diff } from '../diff/diff.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { parseLineRange } from '../line-range.ts';
import { err, ok, type Result } from '../result.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { Side } from '../side.tiny.ts';
import type { CommentAnchor } from './draft-comment.ts';

/** What a note is about, as the agent labels it and the page shows it. */
export const NOTE_LABELS = ['possible bug', 'risk', 'question', 'info'] as const;
export type NoteLabel = (typeof NOTE_LABELS)[number];

/**
 * Where a note is in the reviewer's hands: waiting to be read, dismissed, or
 * promoted into the draft as one of their comments.
 */
export type NoteState = 'waiting' | 'dismissed' | 'promoted';

/** The most notes one `add_notes` call may add. */
export const MAX_NOTES_PER_CALL = 50;

/**
 * The most notes one version may hold. Notes point at something specific;
 * more than this would bury the reviewer's own reading under the agent's.
 */
export const MAX_NOTES_PER_VERSION = 100;

/** The most characters a note's words may have: a pointer and a sentence or two, not an essay. */
export const MAX_NOTE_LENGTH = 2_000;

/** One agent note as stored: its label, its lines on one side of one file, and the agent's words. */
export interface AgentNote {
	readonly id: AgentNoteId;
	readonly version: RevisionNumber;
	readonly label: NoteLabel;
	/** Its lines: the first and last change line of the range the agent named. */
	readonly anchor: CommentAnchor;
	readonly text: AgentMarkdown;
	readonly state: NoteState;
}

/** The notes still waiting on an earlier version than the one shown, which notes are not carried to. */
export interface EarlierNotes {
	readonly version: RevisionNumber;
	readonly waiting: number;
}

/** What the page says where the notes would be, on a version with none, when an earlier one has some. */
export function describeEarlierNotes(earlier: EarlierNotes): ReviewerMessage {
	return reviewerMessage(
		`The agent left ${earlier.waiting === 1 ? '1 note' : `${String(earlier.waiting)} notes`} on version ${String(earlier.version)}; notes stay with the version they were written on.`
	);
}

/** One note as `add_notes` sent it, after its schema has checked its shape. */
export interface NoteRequest {
	readonly label: NoteLabel;
	readonly file: string;
	readonly lines: string;
	readonly text: string;
}

/** A note checked against the diff, ready to store. */
export interface NewNote {
	readonly label: NoteLabel;
	readonly anchor: CommentAnchor;
	readonly text: AgentMarkdown;
}

export type NoteProblem =
	| { readonly kind: 'NoteTarget'; readonly index: ItemIndex; readonly rejection: AssignRejection }
	| { readonly kind: 'NoteNeedsOneRange'; readonly index: ItemIndex; readonly lines: string }
	| {
			readonly kind: 'InvalidNoteText';
			readonly index: ItemIndex;
			readonly reason: 'blank' | 'too-long' | 'malformed';
	  }
	| { readonly kind: 'TooManyNotes'; readonly count: number };

/** What is wrong with one note of a call, for the agent (and the reviewer, who never sees it). */
export function describeNoteProblem(problem: NoteProblem): ReviewerMessage {
	switch (problem.kind) {
		case 'NoteTarget':
			return reviewerMessage(
				`Note ${String(problem.index)}: ${describeRejection(problem.rejection)}`
			);
		case 'NoteNeedsOneRange':
			return reviewerMessage(
				`Note ${String(problem.index)}: "lines" must be one range on one side, such as "+40..+46" or "-12", the lines the note is about; "${problem.lines.slice(0, 80)}" is not. Send a note for each place.`
			);
		case 'InvalidNoteText':
			return reviewerMessage(
				`Note ${String(problem.index)}: the text is ${problem.reason === 'blank' ? 'blank' : problem.reason === 'too-long' ? `longer than ${String(MAX_NOTE_LENGTH)} characters` : 'not valid text'}. Say what you noticed in a sentence or two of Markdown; the reviewer reads the code itself.`
			);
		case 'TooManyNotes':
			return reviewerMessage(
				`This would leave ${String(problem.count)} notes on this version, and a version holds at most ${String(MAX_NOTES_PER_VERSION)}. Notes are for something specific worth the reviewer's attention; keep the ones that matter most, or send "replace": true to put these in place of your earlier ones.`
			);
	}
}

/**
 * Checks each note against the diff, all or nothing: the file must be a
 * changed one, and the lines one range on one side holding at least one
 * change line, as `assign` reads them. The range is narrowed to the change
 * lines inside it, so the note is drawn where the change is.
 */
export function resolveNoteRequests(
	diff: Diff,
	requests: readonly NoteRequest[]
): Result<readonly NewNote[], readonly NoteProblem[]> {
	const notes: NewNote[] = [];
	const problems: NoteProblem[] = [];
	requests.forEach((request, at) => {
		const index = itemIndexAt(at);
		const text =
			request.text.length > MAX_NOTE_LENGTH ? undefined : parseAgentMarkdown(request.text);
		if (text === undefined || !text.ok) {
			problems.push({
				kind: 'InvalidNoteText',
				index,
				reason: text === undefined ? 'too-long' : text.error.reason
			});
			return;
		}
		const resolved = resolveUnits(diff, request.file, request.lines);
		if (!resolved.ok) {
			problems.push({ kind: 'NoteTarget', index, rejection: resolved.error });
			return;
		}
		const { path, units } = resolved.value;
		const sides: readonly Side[] = (['old', 'new'] as const).filter((s) => !units[s].isEmpty);
		const side = sides[0];
		const first = side === undefined ? undefined : units[side].min;
		const last = side === undefined ? undefined : units[side].max;
		const range =
			sides.length !== 1 ||
			units.file ||
			side === undefined ||
			first === undefined ||
			last === undefined
				? undefined
				: parseLineRange(side, first, last);
		if (range === undefined || !range.ok || request.lines.includes(',')) {
			problems.push({ kind: 'NoteNeedsOneRange', index, lines: request.lines });
			return;
		}
		notes.push({ label: request.label, anchor: { path, ...range.value }, text: text.value });
	});
	return problems.length > 0 ? err(problems) : ok(notes);
}

/** Whether two notes say the same thing at the same lines: one sent again adds nothing. */
export function sameNote(a: Omit<NewNote, 'text'> & { text: string }, b: NewNote): boolean {
	return (
		a.label === b.label &&
		a.text === b.text &&
		a.anchor.path === b.anchor.path &&
		a.anchor.side === b.anchor.side &&
		a.anchor.first === b.anchor.first &&
		a.anchor.last === b.anchor.last
	);
}

/** A label as a heading shows it: "Possible bug". */
export function noteLabelWords(label: NoteLabel): string {
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The words of the comment a promoted note becomes: the agent's words quoted,
 * under a line that says they came from an agent note, so the reviewer can
 * edit them into their own and the review never passes them off as theirs.
 */
export function promotedNoteBody(note: Pick<AgentNote, 'label' | 'text'>): string {
	const quoted = note.text
		.trim()
		.split(/\r\n|\r|\n/)
		.map((line) => (line === '' ? '>' : `> ${line}`))
		.join('\n');
	return `From an agent note (${note.label}):\n${quoted}`;
}
