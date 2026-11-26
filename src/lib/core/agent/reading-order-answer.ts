/**
 * A section's reading order in an answer (DESIGN 4.3.1, 7.1): what
 * `set_reading_order` set, and the steps as `get_manifest` lists them, so an
 * agent can read back what it gave. Each step is one line, its file and the
 * change lines in it as `assign` reads them, and its note quoted; a list stops
 * by length as well as by count, so what follows it always fits.
 */
import { formatUnitSpec } from '../diff/line-spec.ts';
import type { FileUnitSet } from '../diff/unit-set.ts';
import { fileUnitSetSize } from '../diff/unit-set.ts';
import { lineRangesOf } from '../line-range.ts';
import type { ReadingStep } from '../reports/reading-order.ts';
import type { SectionId } from '../section-id.tiny.ts';
import {
	changes,
	counted,
	grouped,
	headingLine,
	listedPath,
	MAX_LIST_LENGTH,
	quotedAgentText,
	shortened,
	type ReportHeading
} from './answer.ts';

/** A step's change lines, as `lines` in `assign` and `set_reading_order`. */
function linesOf(units: FileUnitSet): string {
	return formatUnitSpec({
		ranges: [...lineRangesOf('old', units.old), ...lineRangesOf('new', units.new)],
		file: units.file
	});
}

/** The steps, one line each, indented by `indent`; past `budget` characters, how many more. */
export function stepLines(
	steps: readonly ReadingStep[],
	indent = '  ',
	budget = MAX_LIST_LENGTH
): readonly string[] {
	const out: string[] = [];
	let length = 0;
	for (const [at, step] of steps.entries()) {
		const note = step.note === undefined ? '' : `; note ${quotedAgentText(step.note, 300)}`;
		const line = `${indent}${String(at + 1)}. ${listedPath(step.path)} ${shortened(linesOf(step.units), 200)} (${changes(fileUnitSetSize(step.units))})${note}`;
		if (out.length > 0 && length + line.length + 1 > budget) {
			out.push(`${indent}and ${grouped(steps.length - at)} more steps.`);
			break;
		}
		out.push(line);
		length += line.length + 1;
	}
	return out;
}

/** What `set_reading_order` answers: the section's steps now, and what follows them. */
export function renderReadingOrderSet(
	heading: ReportHeading,
	section: SectionId,
	steps: readonly ReadingStep[],
	/** The section's change units no step names, which follow the steps in path order. */
	after: number
): string {
	if (steps.length === 0) {
		return [
			headingLine(heading),
			`${section} has no reading order now: its files are read in path order.`
		].join('\n');
	}
	return [
		headingLine(heading),
		`${section} is read in ${counted(steps.length, 'step', 'steps')}, each a part of its own that the person reads and ticks in this order:`,
		...stepLines(steps),
		after === 0
			? 'Every change line of the section is in a step.'
			: `Then ${changes(after)} no step names, in path order.`,
		'Calling set_reading_order again replaces the order; "steps": [] goes back to path order. get_manifest lists it.'
	].join('\n');
}
