/**
 * `get_coverage` (DESIGN 1.2 rule 2, 7.1): how much is sorted, exactly what is
 * not sorted yet, and the warnings, in an answer of bounded length however
 * large the diff: what is left is listed file by file with its `lines` value,
 * the first files of it, then counted; each file's ranges are cut likewise.
 * It ends with what to do next.
 */
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import { agentPath } from '../diff/agent-text.ts';
import { coverage, describeWarning, type FileUnits } from '../diff/coverage.ts';
import type { Diff } from '../diff/diff.ts';
import type { AssignmentState } from '../diff/state.ts';
import { formatLineRanges } from '../line-range.ts';
import { FILE_UNIT_LABEL } from '../diff/line-spec.ts';
import type { Section } from '../reports/report.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import {
	changes,
	counted,
	grouped,
	headingLine,
	namesListed,
	PAGE_LENGTH,
	type ReportHeading
} from './answer.ts';

/** A section with more change lines than this gets a warning: it is hard to review in one sitting. */
export const MAX_SECTION_UNITS = unitCountOf(800);

/** At most this many warnings are written out; the rest are counted. */
const MAX_WARNINGS = 25;

/** A warning longer than this is cut. */
const MAX_WARNING_LENGTH = 600;

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** At most this many ranges of one file are written out in what is left. */
const MAX_RANGES_PER_FILE = 12;

export interface CoverageInput {
	readonly heading: ReportHeading;
	readonly diff: Diff;
	readonly state: AssignmentState;
	readonly sections: readonly Section[];
	readonly overview: AgentMarkdown | undefined;
}

export function renderCoverage(input: CoverageInput, budget = PAGE_LENGTH): TextForAgent {
	const { diff, state, sections } = input;
	const cover = coverage(diff, state, {
		sections: sections.map((s) => s.id),
		maxSectionUnits: MAX_SECTION_UNITS
	});
	const inSections = [...cover.sections.values()].reduce((n, t) => n + t.units, 0);
	const out: string[] = [
		headingLine(input.heading),
		`${changes(diff.unitCount)} in ${counted(diff.files.length, 'file', 'files')}: ${grouped(inSections)} in sections, ${grouped(cover.ignored.units)} ignored, ${grouped(cover.uncategorised.units)} not sorted yet.`
	];
	if (sections.length > 0) {
		out.push(
			`Sections: ${namesListed(
				sections.map((s) => `${s.id} ${grouped(cover.sections.get(s.id)?.units ?? 0)}`)
			)}.`
		);
	}

	const left = cover.remaining;
	if (left.length === 0) {
		out.push('', 'Nothing is left to sort: every change line is in a section or ignored.');
	} else {
		out.push(
			'',
			`Not sorted yet: ${changes(cover.uncategorised.units)} in ${counted(cover.uncategorised.files, 'file', 'files')} (each line: a file, and the "lines" value that names what is left in it):`
		);
		let length = out.join('\n').length;
		let shown = 0;
		for (const units of left) {
			const line = `${agentPath(units.path)} ${unitsText(units)}`;
			if (shown > 0 && length + line.length + 1 > budget * 0.75) break;
			out.push(line);
			length += line.length + 1;
			shown += 1;
		}
		if (shown < left.length) {
			const more = left.length - shown;
			out.push(
				`… and ${counted(more, 'more file', 'more files')}. Sort whole files or globs first: { "glob": "src/**", "section": "…" } takes everything in them that is not sorted yet, and nothing that is.`
			);
		}
	}

	const warnings = cover.warnings;
	if (warnings.length > 0) {
		out.push('', `Warnings (${grouped(warnings.length)}):`);
		let length = out.join('\n').length;
		let shown = 0;
		for (const warning of warnings) {
			if (shown >= MAX_WARNINGS) break;
			const line = `- ${cut(describeWarning(warning), MAX_WARNING_LENGTH)}`;
			if (shown > 0 && length + line.length + 1 > budget) break;
			out.push(line);
			length += line.length + 1;
			shown += 1;
		}
		if (shown < warnings.length) {
			out.push(
				`… and ${counted(warnings.length - shown, 'more warning', 'more warnings')} like these.`
			);
		}
	}

	out.push('', `Next: ${nextStep(input, left.length === 0)}`);
	return textForAgent(out.join('\n'));
}

function unitsText(units: FileUnits): string {
	const own = units.file ? [FILE_UNIT_LABEL] : [];
	const ranges = units.ranges;
	if (ranges.length <= MAX_RANGES_PER_FILE) {
		return [...own, ...(ranges.length > 0 ? [formatLineRanges(ranges)] : [])].join(',');
	}
	const lines = ranges.reduce((n, r) => n + r.last - r.first + 1, 0);
	return `${[...own, formatLineRanges(ranges.slice(0, MAX_RANGES_PER_FILE))].join(',')} and ${grouped(ranges.length - MAX_RANGES_PER_FILE)} more ranges (${changes(lines)} in all; name the whole file to take them all)`;
}

function nextStep(input: CoverageInput, done: boolean): string {
	if (!done) {
		return input.sections.length === 0
			? 'make sections with upsert_sections, then sort the lines above into them with assign. Put lines that need no review in "ignored", with a reason.'
			: 'sort the lines above with assign, into a section or into "ignored" with a reason, then call get_coverage again.';
	}
	const unsummarised = input.sections.filter((s) => s.summary === undefined).map((s) => s.id);
	const todo: string[] = [];
	if (input.overview === undefined) todo.push('write the overview with set_overview');
	if (unsummarised.length > 0) {
		todo.push(
			`give ${unsummarised.length === 1 ? 'section' : 'sections'} ${namesListed(unsummarised)} a summary with upsert_sections`
		);
	}
	return todo.length === 0
		? 'the report is ready for the person to review. Tell them it is sorted.'
		: `${todo.join(', and ')}. Then the report is ready for the person to review.`;
}
