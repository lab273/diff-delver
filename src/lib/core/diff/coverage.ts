/**
 * Coverage (DESIGN 1.2 rule 2, 4.2): what is in each bucket, exactly what is
 * still uncategorised, and the warnings that tell the agent where its breakdown
 * reads badly. Computed from the state, never trusted from the agent.
 */
import type { HunkId } from '../hunk-id.tiny.ts';
import { formatLineRanges, lineRangesOf, type LineRange } from '../line-range.ts';
import type { RangeMap } from '../range-map.ts';
import { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { SectionId } from '../section-id.tiny.ts';
import { joinTextForAgent, textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import { addUnits, NO_UNITS, ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import { fileCountOf, type FileCount } from '../file-count.tiny.ts';
import { agentPath } from './agent-text.ts';
import { sameBucket, type Bucket } from './bucket.ts';
import type { Diff, DiffFile } from './diff.ts';
import { formatUnitSpec } from './line-spec.ts';
import { ignoreRuleName } from './path-rules.ts';
import { fileAssignment, type Assignment, type AssignmentState } from './state.ts';

export interface Totals {
	readonly units: UnitCount;
	/** Files with at least one unit in the bucket. A file split across buckets counts in each. */
	readonly files: FileCount;
}

/** Some units of one file: line ranges, its file-level unit, or both; never neither. */
export interface FileUnits {
	readonly path: RepoPath;
	readonly ranges: readonly LineRange[];
	/** Whether its file-level unit is among them. */
	readonly file: boolean;
}

export type CoverageWarning =
	| {
			/** A section the agent created holds nothing. */
			readonly kind: 'EmptySection';
			readonly section: SectionId;
	  }
	| {
			/** A section holds more units than the limit, so it is hard to review as one. */
			readonly kind: 'OversizedSection';
			readonly section: SectionId;
			readonly units: UnitCount;
			readonly limit: UnitCount;
	  }
	| {
			/** A run of adjacent deleted and added lines is split between buckets. */
			readonly kind: 'SplitChangeRun';
			readonly path: RepoPath;
			readonly hunk: HunkId;
			/** The whole run. */
			readonly ranges: readonly LineRange[];
			readonly buckets: readonly Bucket[];
	  }
	| {
			/** Test or snapshot units in no section, other than those a rule or pattern ignored. */
			readonly kind: 'TestsOutsideSections';
			readonly units: FileUnits;
	  };

export interface Coverage {
	readonly total: Totals;
	/** Every section with units, and every known section, in the order given, then any others. */
	readonly sections: ReadonlyMap<SectionId, Totals>;
	readonly ignored: Totals;
	readonly uncategorised: Totals;
	/** Exactly what is still uncategorised, file by file. */
	readonly remaining: readonly FileUnits[];
	readonly warnings: readonly CoverageWarning[];
}

export interface CoverageOptions {
	/** The sections the agent has created, in reading order. */
	readonly sections?: readonly SectionId[];
	/** A section with more units than this gets a warning. */
	readonly maxSectionUnits?: UnitCount;
}

class Tally {
	units = NO_UNITS;
	readonly files = new Set<RepoPath>();

	add(path: RepoPath, units: UnitCount): void {
		this.units = addUnits(this.units, units);
		this.files.add(path);
	}

	get totals(): Totals {
		return { units: this.units, files: fileCountOf(this.files.size) };
	}
}

/** What the state covers, and what it does not. */
export function coverage(
	diff: Diff,
	state: AssignmentState,
	options: CoverageOptions = {}
): Coverage {
	const known = options.sections ?? [];
	const sections = new Map<SectionId, Tally>(known.map((id) => [id, new Tally()]));
	const ignored = new Tally();
	const uncategorised = new Tally();
	const remaining: FileUnits[] = [];
	const warnings: CoverageWarning[] = [];

	for (const file of diff.files) {
		const path = file.file.path;
		const assignment = fileAssignment(state, file);
		const count = (a: Assignment, units: UnitCount): void => {
			switch (a.bucket.kind) {
				case 'section': {
					let tally = sections.get(a.bucket.section);
					if (tally === undefined) {
						tally = new Tally();
						sections.set(a.bucket.section, tally);
					}
					tally.add(path, units);
					break;
				}
				case 'ignored':
					ignored.add(path, units);
					break;
				case 'uncategorised':
					uncategorised.add(path, units);
					break;
			}
		};

		const own = assignment.file;
		if (own !== undefined) count(own, ONE_UNIT);
		for (const map of [assignment.old, assignment.new]) {
			for (const s of map.segments) count(s.value, unitCountOf(s.last - s.first + 1));
		}
		const where = (keep: (a: Assignment) => boolean): FileUnits | undefined => {
			const ranges = linesWhere(assignment, keep);
			const withFile = own !== undefined && keep(own);
			return ranges.length > 0 || withFile ? { path, ranges, file: withFile } : undefined;
		};
		const left = where((a) => a.bucket.kind === 'uncategorised');
		if (left !== undefined) remaining.push(left);
		const tests = where(testOutsideSection);
		if (tests !== undefined) warnings.push({ kind: 'TestsOutsideSections', units: tests });
		warnings.push(...splitRuns(file, assignment.old, assignment.new));
	}

	const sectionTotals = new Map([...sections].map(([id, tally]) => [id, tally.totals]));
	const sectionWarnings: CoverageWarning[] = [];
	for (const [section, totals] of sectionTotals) {
		if (totals.units === 0) sectionWarnings.push({ kind: 'EmptySection', section });
		const limit = options.maxSectionUnits;
		if (limit !== undefined && totals.units > limit) {
			sectionWarnings.push({ kind: 'OversizedSection', section, units: totals.units, limit });
		}
	}

	return {
		total: { units: diff.unitCount, files: fileCountOf(diff.files.length) },
		sections: sectionTotals,
		ignored: ignored.totals,
		uncategorised: uncategorised.totals,
		remaining,
		warnings: [...sectionWarnings, ...warnings]
	};
}

function testOutsideSection(a: Assignment): boolean {
	if (a.role === 'code') return false;
	switch (a.bucket.kind) {
		case 'section':
			return false;
		case 'uncategorised':
			return true;
		case 'ignored':
			return a.bucket.by.kind === 'agent';
	}
}

function linesWhere(
	assignment: { readonly old: RangeMap<Assignment>; readonly new: RangeMap<Assignment> },
	keep: (a: Assignment) => boolean
): readonly LineRange[] {
	const side = (map: RangeMap<Assignment>): RangeSet =>
		RangeSet.fromIntervals(map.segments.filter((s) => keep(s.value)));
	return [
		...lineRangesOf('old', side(assignment.old)),
		...lineRangesOf('new', side(assignment.new))
	];
}

/**
 * Whether two buckets count as one for a split run. Every ignored bucket is the
 * same here: lines ignored for different reasons are all left out of the review,
 * so the run does not read badly, and the warning would only say "Ignored and
 * Ignored".
 */
function sameForSplit(a: Bucket, b: Bucket): boolean {
	return (a.kind === 'ignored' && b.kind === 'ignored') || sameBucket(a, b);
}

function splitRuns(
	file: DiffFile,
	old: RangeMap<Assignment>,
	now: RangeMap<Assignment>
): readonly CoverageWarning[] {
	const warnings: CoverageWarning[] = [];
	for (const run of file.runs) {
		const buckets: Bucket[] = [];
		const collect = (map: RangeMap<Assignment>, lines: RangeSet): void => {
			if (lines.min === undefined || lines.max === undefined) return;
			for (const value of map.valuesOverlapping(lines.min, lines.max)) {
				if (!buckets.some((b) => sameForSplit(b, value.bucket))) buckets.push(value.bucket);
			}
		};
		collect(old, run.old);
		collect(now, run.new);
		if (buckets.length > 1) {
			warnings.push({
				kind: 'SplitChangeRun',
				path: file.file.path,
				hunk: run.hunk,
				ranges: [...lineRangesOf('old', run.old), ...lineRangesOf('new', run.new)],
				buckets
			});
		}
	}
	return warnings;
}

// --- Messages ------------------------------------------------------------------

/** How a bucket is named in messages. */
export function describeBucket(bucket: Bucket): TextForAgent {
	return textForAgent(bucketText(bucket));
}

function bucketText(bucket: Bucket): string {
	switch (bucket.kind) {
		case 'section':
			return `section "${bucket.section}"`;
		case 'uncategorised':
			return 'Uncategorised';
		case 'ignored':
			switch (bucket.by.kind) {
				case 'rule':
					return `Ignored (${ignoreRuleName(bucket.by.rule)})`;
				case 'pattern':
					return `Ignored (project pattern ${bucket.by.pattern})`;
				case 'agent':
					return 'Ignored';
			}
	}
}

/** A file's units as the agent names them: its path, then the `lines` value for them. */
function describeUnits(units: FileUnits): TextForAgent {
	return textForAgent(`${agentPath(units.path)} ${formatUnitSpec(units)}`);
}

/** What a warning means and what the agent might do about it. */
export function describeWarning(warning: CoverageWarning): TextForAgent {
	return textForAgent(warningText(warning));
}

function warningText(warning: CoverageWarning): string {
	switch (warning.kind) {
		case 'EmptySection':
			return `Section "${warning.section}" has nothing in it. Assign lines to it, or remove it with upsert_sections ("remove": ["${warning.section}"]).`;
		case 'OversizedSection':
			return `Section "${warning.section}" has ${warning.units} changed lines, more than ${warning.limit}. Consider splitting it so each part can be reviewed in one sitting.`;
		case 'SplitChangeRun':
			return `${agentPath(warning.path)} ${warning.hunk}: the adjacent changed lines ${formatLineRanges(warning.ranges)} are split between ${joinTextForAgent(warning.buckets.map(describeBucket), ' and ')}. This is allowed, but usually reads badly; keep a run together unless the parts really belong apart.`;
		case 'TestsOutsideSections':
			return `${describeUnits(warning.units)}: test lines in no section. Assign them to the section they test, or to a section of their own.`;
	}
}
