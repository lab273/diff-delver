/**
 * Writing a revision's sorting, its sections and which lines are in them, and
 * counting each write: the count is part of a search index's key, so an index
 * is never used once what it was made from has changed. The only code that
 * calls the tables' writes of sections and assignment rows; lint keeps every
 * other module from importing them, so no write can skip the count.
 */
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { Section } from '#lib/core/reports/report.ts';
import type { AssignmentRow } from '#lib/core/storage/stored-units.ts';
import type { Queries } from '../db/index.ts';
import { replaceAssignmentRows } from '../db/tables/assignments.ts';
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

	#count(revision: RevisionId): void {
		this.#writes.set(revision, this.countOf(revision) + 1);
	}
}
