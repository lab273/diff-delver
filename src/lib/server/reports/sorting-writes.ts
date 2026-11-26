/**
 * Writing a revision's sorting, its sections, which lines are in them and the
 * sections' reading orders, and counting each write: the count is part of a
 * search index's key, so an index is never used once what it was made from
 * has changed. The only code that calls the tables' writes of sections,
 * assignment rows and reading steps; lint keeps every other module from
 * importing them, so no write can skip the count.
 */
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { Section } from '#lib/core/reports/report.ts';
import type { AssignmentRow } from '#lib/core/storage/stored-units.ts';
import type { Queries } from '../db/index.ts';
import { replaceAssignmentRows } from '../db/tables/assignments.ts';
import type { SectionId } from '#lib/core/section-id.tiny.ts';
import { replaceReadingSteps, type StoredStep } from '../db/tables/reading-steps.ts';
import { replaceSections } from '../db/tables/sections.ts';

export class SortingWrites {
	readonly #writes = new Map<RevisionId, number>();
	readonly #assignments = new Map<RevisionId, number>();

	/** How many times this revision's sorting has been written here. */
	countOf(revision: RevisionId): number {
		return this.#writes.get(revision) ?? 0;
	}

	/** Assignment writes alone. Section prose and ordering do not change part lines. */
	assignmentsOf(revision: RevisionId): number {
		return this.#assignments.get(revision) ?? 0;
	}

	/** Replaces a revision's sections (see `replaceSections`), counted. */
	replaceSections(q: Queries, revision: RevisionId, sections: readonly Section[]): void {
		this.#count(revision);
		replaceSections(q, revision, sections);
	}

	/** Replaces a revision's assignment rows (see `replaceAssignmentRows`), counted. */
	replaceAssignmentRows(
		q: Queries,
		revision: RevisionId,
		files: ReadonlySet<RepoPath> | 'all',
		rows: readonly AssignmentRow[]
	): void {
		if (files !== 'all' && files.size === 0) return;
		this.#count(revision);
		this.#assignments.set(revision, this.assignmentsOf(revision) + 1);
		replaceAssignmentRows(q, revision, files, rows);
	}

	/**
	 * Replaces a revision's reading orders (see `replaceReadingSteps`), counted
	 * as a write of its assignments too: a part's lines show which step each
	 * change is in, so part reads and search must not use what they read before.
	 */
	replaceReadingSteps(
		q: Queries,
		revision: RevisionId,
		orders: ReadonlyMap<SectionId, readonly StoredStep[]>
	): void {
		this.#count(revision);
		this.#assignments.set(revision, this.assignmentsOf(revision) + 1);
		replaceReadingSteps(q, revision, orders);
	}

	#count(revision: RevisionId): void {
		this.#writes.set(revision, this.countOf(revision) + 1);
	}
}
