/**
 * A section's reading order (DESIGN 4.3.1): the steps the agent gives a
 * section, so it reads in the order the code does (a definition before its
 * use, the change before its test) rather than by path. Pure.
 *
 * - A step is one file, or some of a file's change units, that are in the
 *   section. A step that names a whole file takes the file's units in the
 *   section; one that names lines takes the change units among them. Either
 *   way it takes only what no earlier step of the section took, so a file
 *   named again after some of its lines were a step reads as "the rest of it".
 * - A step that takes nothing is refused, saying why: its lines are in
 *   another place, or an earlier step has them all.
 * - Steps never overlap, so every unit of the section is in exactly one step
 *   or in none; those in none follow the steps, in path order.
 * - Each step may carry a short note, the agent's, shown as the agent's.
 *
 * The steps are stored as the units they hold and carried to the next version
 * as cross-references are (`carryUnitSets`). Whatever the stored steps hold,
 * `effectiveOrders` gives them against a version's assignment state, as they
 * are read: each step only what is still in its section and in no earlier
 * step, and a step left with nothing dropped. So an `assign` that moves lines
 * out of a section, or an update that removes them, never leaves a step that
 * shows nothing.
 */
import {
	parseAgentMarkdown,
	type AgentMarkdown,
	type InvalidAgentMarkdown
} from '../agent-markdown.tiny.ts';
import { describeRejection, resolveUnits, type AssignRejection } from '../diff/assign.ts';
import type { Diff, DiffFile } from '../diff/diff.ts';
import { fileAssignment, type Assignment } from '../diff/state.ts';
import type { AssignmentState } from '../diff/state.ts';
import { fileUnitsOf, type FileUnitSet, type UnitSet } from '../diff/unit-set.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { jsonQuoted } from '../json-quoted.ts';
import { orderStepOf, type OrderStep } from '../order-step.tiny.ts';
import { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { SectionId } from '../section-id.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { shownRepoPath } from '../shown-path.tiny.ts';

/** The most steps one section's reading order may have. */
export const MAX_STEPS = 100;

/** The longest a step's note may be, in characters: a sentence or two. */
export const MAX_STEP_NOTE_LENGTH = 300;

/** One step of a section's reading order. */
export interface ReadingStep {
	readonly path: RepoPath;
	/** The file's change units in this step: never none. */
	readonly units: FileUnitSet;
	/** What to look at in it and why it comes here, as the agent wrote it. */
	readonly note: AgentMarkdown | undefined;
}

/** Each section's reading order. A section in path order has no entry. */
export type ReadingOrders = ReadonlyMap<SectionId, readonly ReadingStep[]>;

/** No section has a reading order. */
export const NO_READING_ORDERS: ReadingOrders = new Map();

/** One step as the agent sent it, after its schema has checked its shape. */
export interface StepRequest {
	readonly file: string;
	/** Line ranges as `assign` reads them; left out, the whole file. */
	readonly lines?: string;
	readonly note?: string;
}

export type StepProblem =
	| { readonly kind: 'TooManySteps'; readonly given: number }
	| { readonly kind: 'InvalidStep'; readonly step: ItemIndex; readonly rejection: AssignRejection }
	| {
			/** None of the units it names is in the section. */
			readonly kind: 'StepOutsideSection';
			readonly step: ItemIndex;
			readonly path: RepoPath;
			readonly section: SectionId;
	  }
	| {
			/** Every unit it names that is in the section is in an earlier step. */
			readonly kind: 'StepAlreadyTaken';
			readonly step: ItemIndex;
			readonly path: RepoPath;
			/** The earlier step that has the first of them, counted from 0. */
			readonly by: ItemIndex;
	  }
	| {
			readonly kind: 'InvalidStepNote';
			readonly step: ItemIndex;
			readonly reason: InvalidAgentMarkdown['reason'];
	  };

/** What is wrong with one problem, for the agent. */
export function describeStepProblem(problem: StepProblem): ReviewerMessage {
	switch (problem.kind) {
		case 'TooManySteps':
			return reviewerMessage(
				`${String(problem.given)} steps is more than ${String(MAX_STEPS)}. Give steps only where path order would read badly; lines no step names follow the steps.`
			);
		case 'InvalidStep':
			return reviewerMessage(
				`Step ${String(problem.step)}: ${describeRejection(problem.rejection)}`
			);
		case 'StepOutsideSection':
			return reviewerMessage(
				`Step ${String(problem.step)}: none of the changes it names in ${quotedPath(problem.path)} are in ${problem.section}. A step orders lines already in the section; assign them to it first, or leave them out.`
			);
		case 'StepAlreadyTaken':
			return reviewerMessage(
				`Step ${String(problem.step)}: every change it names in ${quotedPath(problem.path)} is already in step ${String(problem.by)}. Each line is read once; name lines no earlier step has, or leave this step out.`
			);
		case 'InvalidStepNote':
			return reviewerMessage(
				problem.reason === 'too-long'
					? `Step ${String(problem.step)}: the note is longer than ${String(MAX_STEP_NOTE_LENGTH)} characters. Keep it to a sentence or two on what to look at and why it comes here.`
					: `Step ${String(problem.step)}: the note is ${problem.reason === 'blank' ? 'blank; leave it out instead' : 'not well-formed text'}.`
			);
	}
}

function quotedPath(path: RepoPath): string {
	return jsonQuoted(shownRepoPath(path));
}

/** The units of `file` in `section`. */
function sectionUnits(state: AssignmentState, file: DiffFile, section: SectionId): FileUnitSet {
	const assignment = fileAssignment(state, file);
	const inSection = (a: Assignment): boolean =>
		a.bucket.kind === 'section' && a.bucket.section === section;
	const lines = (side: Side): RangeSet =>
		RangeSet.fromIntervals(
			(side === 'old' ? assignment.old : assignment.new).segments.filter((s) => inSection(s.value))
		);
	return {
		old: lines('old'),
		new: lines('new'),
		file: assignment.file !== undefined && inSection(assignment.file)
	};
}

/** What of `wanted` is in `allowed` and not in `taken`. */
function narrowed(
	wanted: FileUnitSet,
	allowed: FileUnitSet,
	taken: FileUnitSet | undefined
): FileUnitSet | undefined {
	const old = wanted.old.intersect(allowed.old);
	const now = wanted.new.intersect(allowed.new);
	const file = wanted.file && allowed.file;
	if (taken === undefined) return fileUnitsOf(old, now, file);
	return fileUnitsOf(old.subtract(taken.old), now.subtract(taken.new), file && !taken.file);
}

function joined(a: FileUnitSet | undefined, b: FileUnitSet): FileUnitSet {
	if (a === undefined) return b;
	return { old: a.old.union(b.old), new: a.new.union(b.new), file: a.file || b.file };
}

/**
 * A section's reading order from a `set_reading_order` call, against the
 * version's diff and assignment state, or every problem with it. An empty list
 * is path order.
 */
export function orderSection(
	diff: Diff,
	state: AssignmentState,
	section: SectionId,
	requests: readonly StepRequest[]
): Result<readonly ReadingStep[], readonly StepProblem[]> {
	if (requests.length > MAX_STEPS) return err([{ kind: 'TooManySteps', given: requests.length }]);
	const problems: StepProblem[] = [];
	const steps: ReadingStep[] = [];
	/** What earlier steps took, by file, with the first step that took something of each. */
	const taken = new Map<
		RepoPath,
		{ units: FileUnitSet; firsts: { at: number; units: FileUnitSet }[] }
	>();
	requests.forEach((request, at) => {
		const step = itemIndexAt(at);
		const note = request.note === undefined ? undefined : parseAgentMarkdown(request.note);
		if (note !== undefined && !note.ok) {
			problems.push({ kind: 'InvalidStepNote', step, reason: note.error.reason });
		} else if (note !== undefined && Array.from(note.value).length > MAX_STEP_NOTE_LENGTH) {
			problems.push({ kind: 'InvalidStepNote', step, reason: 'too-long' });
		}
		const named = resolveUnits(diff, request.file, request.lines);
		if (!named.ok) {
			problems.push({ kind: 'InvalidStep', step, rejection: named.error });
			return;
		}
		const { path, units } = named.value;
		const file = diff.byPath.get(path);
		if (file === undefined) return; // `resolveUnits` found it in this diff.
		const allowed = sectionUnits(state, file, section);
		const inSection = narrowed(units, allowed, undefined);
		if (inSection === undefined) {
			problems.push({ kind: 'StepOutsideSection', step, path, section });
			return;
		}
		const before = taken.get(path);
		const own = narrowed(units, allowed, before?.units);
		if (own === undefined) {
			const by = before?.firsts.find((f) => narrowed(inSection, f.units, undefined) !== undefined);
			problems.push({ kind: 'StepAlreadyTaken', step, path, by: itemIndexAt(by?.at ?? 0) });
			return;
		}
		taken.set(path, {
			units: joined(before?.units, own),
			firsts: [...(before?.firsts ?? []), { at, units: own }]
		});
		steps.push({ path, units: own, note: note?.ok === true ? note.value : undefined });
	});
	return problems.length > 0 ? err(problems) : ok(steps);
}

/**
 * The reading orders as a version reads them (see the top of this file): each
 * step only what is still in its section and in no earlier step, and a step
 * left with nothing, or a section left with no steps, dropped.
 */
export function effectiveOrders(
	diff: Diff,
	state: AssignmentState,
	orders: ReadingOrders
): ReadingOrders {
	const effective = new Map<SectionId, readonly ReadingStep[]>();
	for (const [section, steps] of orders) {
		const taken = new Map<RepoPath, FileUnitSet>();
		const kept: ReadingStep[] = [];
		for (const step of steps) {
			const file = diff.byPath.get(step.path);
			if (file === undefined) continue;
			const units = narrowed(step.units, sectionUnits(state, file, section), taken.get(step.path));
			if (units === undefined) continue;
			taken.set(step.path, joined(taken.get(step.path), units));
			kept.push({ path: step.path, units, note: step.note });
		}
		if (kept.length > 0) effective.set(section, kept);
	}
	return effective;
}

/** Where a change unit is read in its section: in a step, or after them. */
export class StepLookup {
	readonly #byPath = new Map<
		RepoPath,
		{ readonly section: SectionId; readonly step: OrderStep; readonly units: FileUnitSet }[]
	>();
	readonly #orders: ReadingOrders;

	/** `orders` as `effectiveOrders` gives them, so no two steps share a unit. */
	constructor(orders: ReadingOrders) {
		this.#orders = orders;
		for (const [section, steps] of orders) {
			steps.forEach((step, at) => {
				let list = this.#byPath.get(step.path);
				if (list === undefined) {
					list = [];
					this.#byPath.set(step.path, list);
				}
				list.push({ section, step: orderStepOf(at + 1), units: step.units });
			});
		}
	}

	/** Whether any section has a reading order. */
	get isEmpty(): boolean {
		return this.#orders.size === 0;
	}

	/** The step of `section` a line of `path` is in; undefined when it follows the steps. */
	stepOfLine(section: SectionId, path: RepoPath, side: Side, line: number): OrderStep | undefined {
		const list = this.#byPath.get(path);
		if (list === undefined) return undefined;
		for (const entry of list) {
			if (entry.section !== section) continue;
			if ((side === 'old' ? entry.units.old : entry.units.new).has(line)) return entry.step;
		}
		return undefined;
	}

	/** The step of `section` the file-level unit of `path` is in. */
	stepOfFileUnit(section: SectionId, path: RepoPath): OrderStep | undefined {
		return this.#byPath.get(path)?.find((e) => e.section === section && e.units.file)?.step;
	}

	/** The units of `path` in each step of `section` that has some of them. */
	unitsIn(
		section: SectionId,
		path: RepoPath
	): readonly { readonly step: OrderStep; readonly units: FileUnitSet }[] {
		return (this.#byPath.get(path) ?? []).filter((e) => e.section === section);
	}

	/** A section's steps, in order; none when it reads in path order. */
	stepsOf(section: SectionId): readonly ReadingStep[] {
		return this.#orders.get(section) ?? [];
	}

	/** A step itself. */
	step(section: SectionId, step: OrderStep): ReadingStep | undefined {
		return this.stepsOf(section)[step - 1];
	}
}

/** No reading orders to look anything up in. */
export const NO_STEPS = new StepLookup(NO_READING_ORDERS);

/** A key for one step, in `asUnitSets` and `fromUnitSets`. */
export interface StepKey {
	readonly section: SectionId;
	/** Its place in the section's order, counted from 0. */
	readonly at: number;
}

/** Each step's units, as sets of units of the diff, for carrying them to another version. */
export function asUnitSets(orders: ReadingOrders): ReadonlyMap<string, UnitSet> {
	const sets = new Map<string, UnitSet>();
	for (const [section, steps] of orders) {
		steps.forEach((step, at) => {
			sets.set(stepKeyText({ section, at }), { files: new Map([[step.path, step.units]]) });
		});
	}
	return sets;
}

function stepKeyText(key: StepKey): string {
	return `${key.section}\u0000${String(key.at)}`;
}

/**
 * The reading orders `asUnitSets` made the sets of, after `carried` (the same
 * keys, perhaps fewer, as `carryUnitSets` gives) took them to another version:
 * each step with the units carried, in the order it had; a step whose units
 * all went is left out, and a step whose units went to more than one file (it
 * never does: lines follow renames only) becomes a step for each, in path order.
 */
export function fromUnitSets(
	orders: ReadingOrders,
	carried: ReadonlyMap<string, UnitSet>
): ReadingOrders {
	const out = new Map<SectionId, ReadingStep[]>();
	for (const [section, steps] of orders) {
		const kept: ReadingStep[] = [];
		steps.forEach((step, at) => {
			const set = carried.get(stepKeyText({ section, at }));
			if (set === undefined) return;
			for (const [path, units] of [...set.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
				kept.push({ path, units, note: step.note });
			}
		});
		if (kept.length > 0) out.set(section, kept);
	}
	return out;
}
