/**
 * The diff model (DESIGN 4): everything later layers need to read a diff, sort
 * its change units into buckets and show it. Import from here, not from the
 * individual modules.
 *
 * Typical use:
 *
 * ```ts
 * const files = parseDiffTreeOutput(gitOutput);       // or readDiff() on the server
 * const diff = makeDiff(files.value);                  // works out the change units
 * let state = initialState(diff.value);                // all uncategorised, roles guessed
 * state = autoIgnore(diff.value, state).state;         // lockfiles, vendored code, ...
 * const outcome = assign(diff.value, state, items);    // the agent's assign tool
 * ```
 */

// Values and tiny types the model is made of.
export type { AgentMarkdown } from '../agent-markdown.tiny.ts';
export { parseAgentMarkdown } from '../agent-markdown.tiny.ts';
export type { BlobId } from '../blob-id.tiny.ts';
export { parseBlobId } from '../blob-id.tiny.ts';
export type { FileMode, FileModeKind } from '../file-mode.tiny.ts';
export { fileModeKind, parseFileMode } from '../file-mode.tiny.ts';
export type { FileStatus } from '../file-status.tiny.ts';
export type { GlobMatcher, GlobPattern } from '../glob-pattern.tiny.ts';
export { compileGlob, parseGlobPattern } from '../glob-pattern.tiny.ts';
export type { HunkId } from '../hunk-id.tiny.ts';
export { parseHunkId } from '../hunk-id.tiny.ts';
export type { LineCount } from '../line-count.tiny.ts';
export type { LineNumber } from '../line-number.tiny.ts';
export { parseLineNumber } from '../line-number.tiny.ts';
export type { LineRange } from '../line-range.ts';
export { formatLineRange, formatLineRanges, lineRangesOf, parseLineRange } from '../line-range.ts';
export type { LineText } from '../line-text.tiny.ts';
export type { RepoPath } from '../repo-path.tiny.ts';
export { parseRepoPath } from '../repo-path.tiny.ts';
export type { Role } from '../role.tiny.ts';
export { parseRole, ROLES } from '../role.tiny.ts';
export type { SectionId } from '../section-id.tiny.ts';
export { parseSectionId } from '../section-id.tiny.ts';
export type { Side } from '../side.tiny.ts';
export { parseSide, sideSign } from '../side.tiny.ts';
export type { Similarity } from '../similarity.tiny.ts';
export type { TreeId } from '../tree-id.tiny.ts';
export { parseTreeId } from '../tree-id.tiny.ts';
export type { Interval } from '../range-set.ts';
export { RangeSet } from '../range-set.ts';
export type { Segment } from '../range-map.ts';
export { RangeMap } from '../range-map.ts';

// Reading git's output.
export type {
	AddedLine,
	ContextLine,
	DeletedLine,
	DiffLine,
	FileContent,
	FileDiff,
	FileVersion,
	Hunk,
	HunkSpan
} from './file-diff.ts';
export { hunksOf } from './file-diff.ts';
export type { DiffOutputError } from './diff-output-error.ts';
export { describeDiffOutputError } from './diff-output-error.ts';
export { parseDiffTreeOutput } from './diff-tree-output.ts';

// Change units.
export type { ChangeRun, Diff, DiffFile, DuplicateFilePath, SideLines } from './diff.ts';
export { changedLines, makeDiff } from './diff.ts';

// Buckets, roles and the rules that guess them.
export type { Bucket, IgnoredBy } from './bucket.ts';
export { ignoredBucket, sameBucket, sectionBucket, UNCATEGORISED } from './bucket.ts';
export type { IgnoreRuleId, ProjectRoleRule, RoleRuleId } from './path-rules.ts';
export {
	guessRole,
	IGNORE_RULES,
	ignoreRuleFor,
	ignoreRuleName,
	ROLE_RULES
} from './path-rules.ts';

// Assignment state and the operations on it.
export type { AssignedUnits, Assignment, AssignmentState, FileAssignment } from './state.ts';
export { assignedUnits, fileAssignment, initialState, sameAssignment, unitsIn } from './state.ts';
export type { AutoIgnored, AutoIgnoreOptions, AutoIgnoreOutcome } from './auto-ignore.ts';
export { autoIgnore } from './auto-ignore.ts';
export type {
	AssignItem,
	AssignOptions,
	AssignOutcome,
	AssignRejection,
	AssignRequest,
	AssignTarget,
	Destination,
	InvalidItemProblem
} from './assign.ts';
export {
	assign,
	assignItems,
	describeRejection,
	IGNORED_SECTION,
	parseAssignRequest
} from './assign.ts';
export type { MalformedLines, MalformedLinesProblem } from './line-spec.ts';
export { parseLineSpec } from './line-spec.ts';
export { countUncategorised } from './totals.ts';

// Coverage.
export type { Coverage, CoverageOptions, CoverageWarning, FileUnits, Totals } from './coverage.ts';
export { coverage, describeBucket, describeWarning } from './coverage.ts';
