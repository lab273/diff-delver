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
 * - `references`, when an item gives it, is the section's whole list of
 *   cross-references (DESIGN 4.3): changed lines that live in another section
 *   and matter to this one, each a file and a `lines` value as `assign` reads
 *   them. Only the changed units they name are kept. Left out, the section
 *   keeps the ones it had; an empty list clears them.
 * - `remove` names sections to remove. Only a section that holds nothing can
 *   go, so no line is ever left without a home; its cross-references go with it.
 *
 * All or nothing: when any item, the order or a removal has a problem, nothing
 * changes. A section that holds nothing and is not removed stays, and
 * `coverage` reports it.
 */
import { parseAgentMarkdown, type InvalidAgentMarkdown } from '../agent-markdown.tiny.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { describeRejection, resolveUnits, type AssignRejection } from '../diff/assign.ts';
import type { Diff } from '../diff/diff.ts';
import { fileUnitsOf, type FileUnitSet, type UnitSet } from '../diff/unit-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { UnitCount } from '../unit-count.tiny.ts';
import { parseSectionId, type InvalidSectionIdReason, type SectionId } from '../section-id.tiny.ts';
import { parseSectionTitle, type InvalidSectionTitleReason } from '../section-title.tiny.ts';
import type { Section } from './report.ts';

/** One cross-reference as the agent sent it: a file and the lines in it, as `assign` reads them. */
export interface ReferenceRequest {
	readonly file: string;
	readonly lines: string;
}

/** One item as the agent sent it, after its schema has checked its shape. */
export interface SectionRequest {
	readonly id: string;
	readonly title?: string;
	readonly summary?: string;
	/** The section's whole list of cross-references; left out, it keeps the ones it has. */
	readonly references?: readonly ReferenceRequest[];
}

/** The most cross-references one section may have. */
export const MAX_REFERENCES = 50;

/**
 * The most sections a report may have. A section is one thing a reviewer can
 * hold in their head, read in order; a reading order longer than this is no
 * longer one a person can follow, and every answer that lists the sections
 * stays short enough to read whole.
 */
export const MAX_SECTIONS = 50;

/**
 * Each section's cross-references: changed units of the diff that live in
 * another section and matter to this one. A section with none has no entry.
 */
export type SectionReferences = ReadonlyMap<SectionId, UnitSet>;

/** What a revision's sections are: in reading order, with their cross-references. */
export interface SectionsAfter {
	readonly sections: readonly Section[];
	readonly references: SectionReferences;
}

/** What an `upsert_sections` call asks for, after its schema has checked its shape. */
export interface SectionChange {
	readonly sections: readonly SectionRequest[];
	/** The whole new reading order, when given. */
	readonly order?: readonly string[];
	/** Sections to remove; each must hold nothing. */
	readonly remove?: readonly string[];
}

/** What the change needs to know beyond the sections: the diff, and what each section holds. */
export interface SectionContext {
	readonly diff: Diff;
	/** How many change units are in a section now. */
	readonly unitsIn: (section: SectionId) => UnitCount;
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
			readonly kind: 'InvalidReference';
			readonly index: ItemIndex;
			/** The reference's position in the item's list. */
			readonly reference: ItemIndex;
			readonly rejection: AssignRejection;
	  }
	| { readonly kind: 'TooManyReferences'; readonly index: ItemIndex; readonly given: number }
	| { readonly kind: 'TooManySections'; readonly count: number }
	| { readonly kind: 'RemoveUnknown'; readonly id: string; readonly known: readonly SectionId[] }
	| { readonly kind: 'RemoveNotEmpty'; readonly id: SectionId; readonly units: UnitCount }
	| { readonly kind: 'RemovedAndChanged'; readonly id: SectionId }
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
		case 'InvalidReference':
			return reviewerMessage(
				`Item ${String(problem.index)}, reference ${String(problem.reference)}: ${describeRejection(problem.rejection)}`
			);
		case 'TooManyReferences':
			return reviewerMessage(
				`Item ${String(problem.index)}: ${String(problem.given)} cross-references is more than ${String(MAX_REFERENCES)}. Keep the ones a reader of this section most needs; a range such as "+40..+62" can cover many lines at once.`
			);
		case 'TooManySections':
			return reviewerMessage(
				`This would make ${String(problem.count)} sections, and a report has at most ${String(MAX_SECTIONS)}: each section is one thing a reviewer holds in their head, so a reading order longer than that is too long to follow. Join closely related changes into one section, or remove sections that hold nothing.`
			);
		case 'RemoveUnknown':
			return reviewerMessage(
				problem.known.length > 0
					? `"${echo(problem.id)}" cannot be removed: there is no such section. The sections are ${problem.known.join(', ')}.`
					: `"${echo(problem.id)}" cannot be removed: there are no sections yet.`
			);
		case 'RemoveNotEmpty':
			return reviewerMessage(
				`${problem.id} cannot be removed: it still holds ${String(problem.units)} changed ${problem.units === 1 ? 'line' : 'lines'}. Move them to another section with assign first, naming them with "lines", then remove it.`
			);
		case 'RemovedAndChanged':
			return reviewerMessage(
				`${problem.id} is both changed and removed in the same call. Do one or the other.`
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

/** At most this much of the agent's own text is repeated in a message. */
const MAX_ECHOED = 80;

function echo(text: string): string {
	const chars = Array.from(text);
	return JSON.stringify(
		chars.length <= MAX_ECHOED ? text : `${chars.slice(0, MAX_ECHOED).join('')}…`
	).slice(1, -1);
}

/**
 * The sections and cross-references after a whole `upsert_sections` call, or
 * every problem with it: the items, then the removals, then the order, which
 * must list every section that is left.
 */
export function applySectionChange(
	existing: SectionsAfter,
	change: SectionChange,
	context: SectionContext
): Result<SectionsAfter, readonly SectionProblem[]> {
	const problems: SectionProblem[] = [];
	const references = new Map(existing.references);
	change.sections.forEach((request, position) => {
		if (request.references === undefined) return;
		const index = itemIndexAt(position);
		const id = parseSectionId(request.id);
		if (!id.ok) return; // Reported with the item.
		if (request.references.length > MAX_REFERENCES) {
			problems.push({ kind: 'TooManyReferences', index, given: request.references.length });
			return;
		}
		const files = new Map<RepoPath, FileUnitSet>();
		request.references.forEach((reference, at) => {
			const units = resolveUnits(context.diff, reference.file, reference.lines);
			if (!units.ok) {
				problems.push({
					kind: 'InvalidReference',
					index,
					reference: itemIndexAt(at),
					rejection: units.error
				});
				return;
			}
			const before = files.get(units.value.path);
			const merged =
				before === undefined
					? units.value.units
					: fileUnitsOf(
							before.old.union(units.value.units.old),
							before.new.union(units.value.units.new),
							before.file || units.value.units.file
						);
			if (merged !== undefined) files.set(units.value.path, merged);
		});
		if (files.size > 0) references.set(id.value, { files });
		else references.delete(id.value);
	});

	const sections = applySectionRequests(existing.sections, change.sections);
	if (!sections.ok) problems.unshift(...sections.error);
	let kept = sections.ok ? sections.value : existing.sections;

	const changed = new Set(change.sections.map((s) => s.id));
	for (const text of change.remove ?? []) {
		const section = kept.find((s) => s.id === text);
		if (section === undefined) {
			problems.push({ kind: 'RemoveUnknown', id: text, known: kept.map((s) => s.id) });
			continue;
		}
		if (changed.has(text)) {
			problems.push({ kind: 'RemovedAndChanged', id: section.id });
			continue;
		}
		const units = context.unitsIn(section.id);
		if (units > 0) {
			problems.push({ kind: 'RemoveNotEmpty', id: section.id, units });
			continue;
		}
		kept = kept.filter((s) => s.id !== section.id);
		references.delete(section.id);
	}

	if (change.order !== undefined) {
		const ordered = applySectionRequests(kept, [], change.order);
		if (!ordered.ok) problems.push(...ordered.error);
		else kept = ordered.value;
	}
	if (kept.length > MAX_SECTIONS && kept.length > existing.sections.length) {
		problems.push({ kind: 'TooManySections', count: kept.length });
	}
	return problems.length > 0 ? err(problems) : ok({ sections: kept, references });
}
