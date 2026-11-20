/**
 * `upsert_sections` (DESIGN 7.1): the agent creates, retitles, summarises and
 * reorders sections. Pure: given the sections a revision has and the agent's
 * requests, the sections it will have, or every problem with the requests.
 *
 * - An item names a section by id. A new section needs a title; an existing one
 *   keeps whatever the item leaves out.
 * - A new section goes at the end of the reading order, in the order given.
 * - `order`, when given, is the whole new reading order: every section, old and
 *   new, exactly once.
 *
 * All or nothing: when any item or the order has a problem, nothing changes.
 * Sections are never removed here; a section stays until the revision is
 * replaced, and one that holds nothing is reported by `coverage`.
 */
import { parseAgentMarkdown, type InvalidAgentMarkdown } from '../agent-markdown.tiny.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { parseSectionId, type InvalidSectionIdReason, type SectionId } from '../section-id.tiny.ts';
import { parseSectionTitle, type InvalidSectionTitleReason } from '../section-title.tiny.ts';
import type { Section } from './report.ts';

/** One item as the agent sent it, after its schema has checked its shape. */
export interface SectionRequest {
	readonly id: string;
	readonly title?: string;
	readonly summary?: string;
}

export type SectionProblem =
	| {
			readonly kind: 'InvalidSectionId';
			readonly index: ItemIndex;
			readonly id: string;
			readonly reason: InvalidSectionIdReason;
	  }
	| {
			readonly kind: 'InvalidTitle';
			readonly index: ItemIndex;
			readonly reason: InvalidSectionTitleReason;
	  }
	| {
			readonly kind: 'InvalidSummary';
			readonly index: ItemIndex;
			readonly reason: InvalidAgentMarkdown['reason'];
	  }
	| { readonly kind: 'MissingTitle'; readonly index: ItemIndex; readonly id: SectionId }
	| { readonly kind: 'RepeatedSection'; readonly index: ItemIndex; readonly id: SectionId }
	| {
			readonly kind: 'IncompleteOrder';
			/** Sections the order leaves out. */
			readonly missing: readonly SectionId[];
			/** Ids in the order that are no section, or appear twice. */
			readonly unexpected: readonly string[];
	  };

/** What is wrong with one problem, for the agent and the reviewer. */
export function describeSectionProblem(problem: SectionProblem): ReviewerMessage {
	switch (problem.kind) {
		case 'InvalidSectionId':
			return reviewerMessage(
				`Item ${String(problem.index)}: "${problem.id}" is not a section id (${problem.reason}). Use a short slug of lowercase letters and digits, such as session-expiry.`
			);
		case 'InvalidTitle':
			return reviewerMessage(
				`Item ${String(problem.index)}: the title is ${problem.reason === 'blank' ? 'blank' : problem.reason === 'too-long' ? 'longer than 200 characters' : problem.reason === 'line-break' ? 'more than one line' : 'not valid text'}. Give a short title on one line.`
			);
		case 'InvalidSummary':
			return reviewerMessage(
				`Item ${String(problem.index)}: the summary is ${problem.reason === 'blank' ? 'blank' : problem.reason === 'too-long' ? 'too long' : 'not valid text'}. Leave it out, or write a summary in Markdown.`
			);
		case 'MissingTitle':
			return reviewerMessage(
				`Item ${String(problem.index)}: ${problem.id} is a new section, so it needs a title.`
			);
		case 'RepeatedSection':
			return reviewerMessage(
				`Item ${String(problem.index)}: ${problem.id} appears earlier in the same call. Name each section once.`
			);
		case 'IncompleteOrder': {
			const parts = [
				...(problem.missing.length > 0 ? [`it leaves out ${problem.missing.join(', ')}`] : []),
				...(problem.unexpected.length > 0
					? [
							`${problem.unexpected.join(', ')} ${problem.unexpected.length === 1 ? 'is' : 'are'} not a section or appear twice`
						]
					: [])
			];
			return reviewerMessage(
				`The order must list every section exactly once, but ${parts.join(' and ')}. Send the whole reading order, or leave the order out.`
			);
		}
	}
}

/** The sections after the requests, in reading order, or every problem with them. */
export function applySectionRequests(
	existing: readonly Section[],
	requests: readonly SectionRequest[],
	order?: readonly string[]
): Result<readonly Section[], readonly SectionProblem[]> {
	const problems: SectionProblem[] = [];
	const sections = new Map<SectionId, Section>(existing.map((s) => [s.id, s]));
	const seen = new Set<SectionId>();
	requests.forEach((request, position) => {
		const index = itemIndexAt(position);
		const id = parseSectionId(request.id);
		if (!id.ok) {
			problems.push({ kind: 'InvalidSectionId', index, id: request.id, reason: id.error.reason });
			return;
		}
		if (seen.has(id.value)) {
			problems.push({ kind: 'RepeatedSection', index, id: id.value });
			return;
		}
		seen.add(id.value);
		const title = request.title === undefined ? undefined : parseSectionTitle(request.title);
		if (title !== undefined && !title.ok) {
			problems.push({ kind: 'InvalidTitle', index, reason: title.error.reason });
		}
		const summary = request.summary === undefined ? undefined : parseAgentMarkdown(request.summary);
		if (summary !== undefined && !summary.ok) {
			problems.push({ kind: 'InvalidSummary', index, reason: summary.error.reason });
		}
		const before = sections.get(id.value);
		const newTitle = title?.ok === true ? title.value : before?.title;
		if (newTitle === undefined) {
			if (title === undefined) problems.push({ kind: 'MissingTitle', index, id: id.value });
			return;
		}
		sections.set(id.value, {
			id: id.value,
			title: newTitle,
			summary: summary?.ok === true ? summary.value : before?.summary
		});
	});
	let ordered = [...sections.values()];
	if (order !== undefined) {
		const placed = new Set<SectionId>();
		const unexpected: string[] = [];
		const reordered: Section[] = [];
		for (const text of order) {
			const id = parseSectionId(text);
			const section = id.ok ? sections.get(id.value) : undefined;
			if (section === undefined || placed.has(section.id)) {
				unexpected.push(text);
				continue;
			}
			placed.add(section.id);
			reordered.push(section);
		}
		const missing = ordered.filter((s) => !placed.has(s.id)).map((s) => s.id);
		if (missing.length > 0 || unexpected.length > 0) {
			problems.push({ kind: 'IncompleteOrder', missing, unexpected });
		}
		ordered = reordered;
	}
	return problems.length > 0 ? err(problems) : ok(ordered);
}
