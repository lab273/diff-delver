/**
 * What `add_notes` answers (DESIGN 7.1): what the call did to the version's
 * notes, what the person can do with them, and how to replace them. Short
 * whatever was sent, since it lists nothing.
 */
import { counted, headingLine, type ReportHeading } from './answer.ts';

/** What an `add_notes` call did, as the report service counted it. */
export interface NotesOutcome {
	readonly added: number;
	readonly repeated: number;
	readonly removed: number;
	readonly total: number;
	readonly actedOn: number;
}

export function renderNotesAdded(heading: ReportHeading, outcome: NotesOutcome): string {
	const version = `version ${String(heading.version)}`;
	const did = [
		...(outcome.removed > 0
			? [
					`Removed ${counted(outcome.removed, 'earlier note', 'earlier notes')} the person had not acted on.`
				]
			: []),
		outcome.added === 0 ? 'Added no notes.' : `Added ${counted(outcome.added, 'note', 'notes')}.`,
		...(outcome.repeated > 0
			? [
					`${counted(outcome.repeated, 'note was', 'notes were')} on ${version} already, so ${outcome.repeated === 1 ? 'it was' : 'they were'} passed over: sending a call again adds nothing more, and a note the person dismissed stays dismissed.`
				]
			: [])
	];
	const held =
		outcome.total === 0
			? `${version.charAt(0).toUpperCase()}${version.slice(1)} holds no notes now.`
			: `${version.charAt(0).toUpperCase()}${version.slice(1)} holds ${counted(outcome.total, 'note', 'notes')} now${outcome.actedOn > 0 ? `; the person has dismissed or promoted ${String(outcome.actedOn)} of them` : ''}.`;
	return [
		headingLine(heading),
		did.join(' '),
		held,
		'The person sees each note at its lines, marked as an agent note, after their own reading: they may dismiss it, or promote it into their review as a comment of their own. A note never reaches the review otherwise.',
		'To put a new set in place of these, send add_notes with "replace": true: it removes the notes the person has not acted on, then adds the ones you send ("notes": [] removes them only).'
	].join('\n');
}
