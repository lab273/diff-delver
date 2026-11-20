/**
 * Moves what nobody needs to review into `Ignored` before the agent starts
 * (DESIGN 4.2): files a project pattern names, files `.gitattributes` marks
 * `linguist-generated`, and files a built-in rule recognises. Only uncategorised
 * units move, so running it again, or after the agent, undoes nothing.
 */
import { addUnits, NO_UNITS, type UnitCount } from '../unit-count.tiny.ts';
import { compileGlob, type GlobPattern } from '../glob-pattern.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { ignoredBucket, type IgnoredBy } from './bucket.ts';
import type { RangeMap } from '../range-map.ts';
import type { Diff, DiffFile } from './diff.ts';
import { ignoreRuleFor } from './path-rules.ts';
import {
	assignedUnits,
	fileAssignment,
	unitsIn,
	type Assignment,
	type AssignmentState,
	type FileAssignment
} from './state.ts';

export interface AutoIgnoreOptions {
	/** Ignore patterns from the project's `.diff-delver.toml`. */
	readonly projectPatterns?: readonly GlobPattern[];
	/** Paths `.gitattributes` marks `linguist-generated`, as git reports them. */
	readonly markedGenerated?: ReadonlySet<RepoPath>;
}

export interface AutoIgnored {
	readonly path: RepoPath;
	readonly by: IgnoredBy;
	/** How many units moved. */
	readonly units: UnitCount;
}

export interface AutoIgnoreOutcome {
	readonly state: AssignmentState;
	/** Each file that had units moved, and why. */
	readonly ignored: readonly AutoIgnored[];
}

/** Ignores the uncategorised units of every file a rule or pattern covers. */
export function autoIgnore(
	diff: Diff,
	state: AssignmentState,
	options: AutoIgnoreOptions = {}
): AutoIgnoreOutcome {
	const patterns = (options.projectPatterns ?? []).map((pattern) => ({
		pattern,
		matches: compileGlob(pattern)
	}));
	const files = new Map(state.files);
	const ignored: AutoIgnored[] = [];
	for (const file of diff.files) {
		const path = file.file.path;
		const pattern = patterns.find((p) => p.matches(path))?.pattern;
		const rule =
			options.markedGenerated?.has(path) === true ? 'linguist-generated' : ignoreRuleFor(path);
		const by: IgnoredBy | undefined =
			pattern !== undefined
				? { kind: 'pattern', pattern }
				: rule !== undefined
					? { kind: 'rule', rule }
					: undefined;
		if (by === undefined) continue;
		const units = uncategorisedUnits(state, file);
		if (units === 0) continue;
		files.set(path, ignoreUncategorised(fileAssignment(state, file), by));
		ignored.push({ path, by, units });
	}
	return { state: { files }, ignored };
}

function ignoreUncategorised(assignment: FileAssignment, by: IgnoredBy): FileAssignment {
	const bucket = ignoredBucket(by);
	switch (assignment.kind) {
		case 'file':
			return assignment.assignment.bucket.kind === 'uncategorised'
				? { kind: 'file', assignment: { ...assignment.assignment, bucket } }
				: assignment;
		case 'lines': {
			const update = (map: RangeMap<Assignment>): RangeMap<Assignment> =>
				map.update(map.domain, (a) => (a.bucket.kind === 'uncategorised' ? { ...a, bucket } : a));
			return { kind: 'lines', old: update(assignment.old), new: update(assignment.new) };
		}
	}
}

function uncategorisedUnits(state: AssignmentState, file: DiffFile): UnitCount {
	return assignedUnits(state, file)
		.filter((u) => u.assignment.bucket.kind === 'uncategorised')
		.reduce((sum, u) => addUnits(sum, unitsIn(u)), NO_UNITS);
}
