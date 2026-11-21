/**
 * The answer to `assign` (DESIGN 7.1): what each item took, what was refused
 * and why, and how many change lines are still not sorted, with what to do
 * next. Sending the same items again is harmless and says so: a whole file or
 * glob that is already where it was sent says it is already there.
 */
import {
	describeNothingTaken,
	describeRangesTakingNothing,
	describeRejection,
	IGNORED_SECTION,
	type AssignOutcome,
	type AssignRequest
} from '../diff/assign.ts';
import type { Bucket } from '../diff/bucket.ts';
import { coverage } from '../diff/coverage.ts';
import type { Diff } from '../diff/diff.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import {
	changes,
	counted,
	grouped,
	headingLine,
	PAGE_LENGTH,
	quotedAgentText,
	type ReportHeading
} from './answer.ts';

/** The most items one `assign` call takes. */
export const MAX_ASSIGN_ITEMS = 200;

export interface AssignAnswerInput {
	readonly heading: ReportHeading;
	readonly diff: Diff;
	readonly requests: readonly AssignRequest[];
	readonly outcome: AssignOutcome;
}

/** Where an item sent its change lines, in words. */
function destination(request: AssignRequest): string {
	if (request.section === undefined) {
		return request.role === undefined ? 'nowhere' : `role ${request.role}`;
	}
	return request.section === IGNORED_SECTION
		? 'Ignored'
		: `section ${quotedAgentText(request.section, 64)}`;
}

export function renderAssign(input: AssignAnswerInput, budget = PAGE_LENGTH): TextForAgent {
	const { outcome, requests } = input;
	const lines: { index: number; text: string }[] = [];
	for (const item of outcome.accepted) {
		const request: AssignRequest = requests[item.index] ?? {};
		const where = destination(request);
		const roleOnly = request.section === undefined;
		let text: string;
		if (item.units > 0) {
			text = roleOnly
				? `Item ${String(item.index)}: set the role of ${changes(item.units)} to ${request.role ?? ''}.`
				: `Item ${String(item.index)}: took ${changes(item.units)} into ${where}${request.role === undefined ? '' : `, with role ${request.role}`}.`;
		} else if (item.nothingTaken !== undefined) {
			const [only, ...others] = item.nothingTaken.sortedInto;
			const already = others.length === 0 && only !== undefined && isDestination(only, request);
			text = already
				? `Item ${String(item.index)}: nothing more to take, everything it names is already in ${where}.`
				: `Item ${String(item.index)}: ${describeNothingTaken(item.nothingTaken)}`;
		} else {
			text = `Item ${String(item.index)}: took nothing.`;
		}
		if (item.rangesTakingNothing !== undefined) {
			text += ` ${describeRangesTakingNothing(item.rangesTakingNothing)}`;
		}
		lines.push({ index: item.index, text });
	}
	for (const { index, rejection } of outcome.rejected) {
		lines.push({
			index,
			text: `Item ${String(index)} was refused, and changed nothing: ${describeRejection(rejection)}`
		});
	}
	lines.sort((a, b) => a.index - b.index);

	const cover = coverage(input.diff, outcome.state);
	const out: string[] = [headingLine(input.heading)];
	const refused = outcome.rejected.length;
	out.push(
		refused === 0
			? requests.length === 1
				? 'The item was applied.'
				: `All ${grouped(requests.length)} items were applied.`
			: `${grouped(requests.length - refused)} of ${counted(requests.length, 'item was', 'items were')} applied; ${grouped(refused)} refused. Fix the refused ones and send only those again.`
	);
	let length = out.join('\n').length;
	let shown = 0;
	for (const line of lines) {
		if (shown > 0 && length + line.text.length + 1 > budget) break;
		out.push(line.text);
		length += line.text.length + 1;
		shown += 1;
	}
	if (shown < lines.length) {
		out.push(
			`… and ${counted(lines.length - shown, 'more item', 'more items')}, not written out to keep this short.`
		);
	}
	const left = cover.uncategorised;
	out.push(
		'',
		left.units === 0
			? 'Nothing is left to sort: every change line is in a section or ignored. Next: get_coverage, for warnings and what is still to write.'
			: `Not sorted yet: ${changes(left.units)} in ${counted(left.files, 'file', 'files')}. get_coverage lists them.`
	);
	return textForAgent(out.join('\n'));
}

/** Whether a bucket is where the item sends its change lines. */
function isDestination(bucket: Bucket, request: AssignRequest): boolean {
	switch (bucket.kind) {
		case 'section':
			return request.section === bucket.section;
		case 'ignored':
			return request.section === IGNORED_SECTION;
		case 'uncategorised':
			return false;
	}
}
