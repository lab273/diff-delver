/**
 * `get_manifest` (DESIGN 7.1): what the agent reads first. A summary of the
 * whole diff (its size, where its change lines are, the sections in reading
 * order and the overview's state), then one compact line per file, in pages,
 * so a diff of 2,000 files is read in a few calls and none is too long.
 *
 * ```
 * Report r_1: Uncommitted changes in shop, version 1.
 * 3 files, 42 change lines: 30 not sorted yet, 10 in 1 section, 2 ignored.
 * ...
 * Files (2 of 3 sorted by path; path: how it changed, lines, hunks, role, where its change lines are):
 * src/pay.ts: changed, +12 -3, h1..h2, code; not sorted 15
 * package-lock.json: changed, +2 -0, h1, code; ignored 2 (Lockfile)
 * ```
 */
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import { agentPath } from '../diff/agent-text.ts';
import type { Bucket } from '../diff/bucket.ts';
import { coverage } from '../diff/coverage.ts';
import type { Diff, DiffFile } from '../diff/diff.ts';
import { describeFileChange } from '../diff/file-unit.ts';
import { ignoreRuleName } from '../diff/path-rules.ts';
import { assignedUnits, unitsIn, type AssignmentState } from '../diff/state.ts';
import type { SectionReferences } from '../reports/section-requests.ts';
import type { Section } from '../reports/report.ts';
import type { Role } from '../role.tiny.ts';
import { unitSetSize } from '../diff/unit-set.ts';
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
import { filterKey, pageCursor, type CursorPosition } from './page-cursor.tiny.ts';

export interface ManifestInput {
	readonly heading: ReportHeading;
	readonly diff: Diff;
	readonly state: AssignmentState;
	readonly sections: readonly Section[];
	readonly references: SectionReferences;
	readonly overview: AgentMarkdown | undefined;
	/** Files the snapshot could not include, one sentence each. */
	readonly leftOut: readonly string[];
}

/** The key of the manifest's pages: it has no filters. */
export const MANIFEST_KEY = filterKey('manifest');

/** One page of the manifest, starting at file `from`; the first page has the summary. */
export function renderManifest(input: ManifestInput, from = 0, budget = PAGE_LENGTH): TextForAgent {
	const { heading, diff } = input;
	const out: string[] = [headingLine(heading)];
	if (from === 0) out.push(...summary(input), '');
	const total = diff.files.length;
	if (total === 0) {
		out.push('The diff has no files.');
		return textForAgent(out.join('\n'));
	}
	const lines: string[] = [];
	let length = out.join('\n').length;
	let next = from;
	while (next < total) {
		const file = diff.files[next];
		if (file === undefined) break;
		const line = fileLine(file, input.state);
		if (lines.length > 0 && length + line.length + 1 > budget) break;
		lines.push(line);
		length += line.length + 1;
		next += 1;
	}
	const shown =
		from === 0 && next === total
			? `Files (all ${grouped(total)}, by path. Each line: path: how it changed, lines added and deleted, hunk ids, role; then where its change lines are now):`
			: `Files ${grouped(from + 1)} to ${grouped(next)} of ${grouped(total)}, by path (path: how it changed, lines added and deleted, hunk ids, role; then where its change lines are now):`;
	out.push(shown, ...lines);
	if (next < total) {
		const cursor = pageCursor({ version: heading.version, file: next, line: 0, key: MANIFEST_KEY });
		out.push(
			'',
			`More files follow. Call get_manifest with "report": "${heading.id}" and "cursor": "${cursor}" for the next ${next - from === 1 ? 'one' : 'page'}.`
		);
	}
	return textForAgent(out.join('\n'));
}

/** Whether a cursor's position fits the manifest of this diff and version. */
export function manifestPosition(position: CursorPosition, input: ManifestInput): boolean {
	return (
		position.key === MANIFEST_KEY &&
		position.version === input.heading.version &&
		position.line === 0 &&
		position.file > 0 &&
		position.file < input.diff.files.length
	);
}

function summary(input: ManifestInput): readonly string[] {
	const { diff, state, sections } = input;
	const cover = coverage(diff, state, { sections: sections.map((s) => s.id) });
	const inSections = [...cover.sections.values()].reduce((n, t) => n + t.units, 0);
	const out: string[] = [
		`${counted(diff.files.length, 'file', 'files')}, ${changes(diff.unitCount)}: ${grouped(cover.uncategorised.units)} not sorted yet, ${grouped(inSections)} in ${counted(sections.length, 'section', 'sections')}, ${grouped(cover.ignored.units)} ignored.`,
		'A change line is one added line (labelled +<line> in get_diff) or one deleted line (-<line>), or the change to a file itself (labelled "file"): a rename, a mode or kind change, or a change with no lines, such as a binary file.'
	];
	out.push(
		input.overview === undefined
			? 'Overview: not written yet. Write it with set_overview once the sections are clear.'
			: `Overview: written (${counted(Array.from(input.overview).length, 'character', 'characters')}).`
	);
	if (sections.length === 0) {
		out.push(
			'Sections: none yet. Make them with upsert_sections, then put lines in them with assign.'
		);
	} else {
		out.push('Sections, in reading order (id, title, what is in it):');
		for (const section of sections) {
			const totals = cover.sections.get(section.id);
			const refs = input.references.get(section.id);
			const parts = [
				`${changes(totals?.units ?? 0)} in ${counted(totals?.files ?? 0, 'file', 'files')}`,
				...(refs === undefined ? [] : [`${changes(unitSetSize(refs))} cross-referenced`]),
				...(section.summary === undefined ? ['no summary yet'] : [])
			];
			out.push(`  ${section.id}: ${quotedAgentText(section.title, 120)}, ${parts.join(', ')}`);
		}
	}
	for (const left of input.leftOut) out.push(`Left out of the diff: ${left}`);
	return out;
}

const ROLE_ORDER: readonly Role[] = ['code', 'test', 'snapshot'];

/** One file in one line. */
function fileLine(file: DiffFile, state: AssignmentState): string {
	const f = file.file;
	const added = file.changed.new.size;
	const deleted = file.changed.old.size;
	const hunkIds = [...file.hunks.keys()];
	const hunks =
		hunkIds.length === 0
			? 'no lines: one change to the file, "file"'
			: hunkIds.length === 1
				? (hunkIds[0] ?? '')
				: `${hunkIds[0] ?? ''}..${hunkIds.at(-1) ?? ''}`;
	const roles = new Set<Role>();
	const where = new Map<string, number>();
	for (const run of assignedUnits(state, file)) {
		roles.add(run.assignment.role);
		const name = bucketName(run.assignment.bucket);
		where.set(name, (where.get(name) ?? 0) + unitsIn(run));
	}
	const role = ROLE_ORDER.filter((r) => roles.has(r)).join('+');
	const own = file.hasFileUnit && file.hasLines ? ', and "file"' : '';
	const buckets = [...where].map(([name, n]) => `${name} ${grouped(n)}`).join(', ');
	return `${agentPath(f.path)}: ${describeFileChange(f)}, +${grouped(added)} -${grouped(deleted)}, ${hunks}${own}, ${role}; ${buckets}`;
}

/** How a bucket is named in a file's line. */
function bucketName(bucket: Bucket): string {
	switch (bucket.kind) {
		case 'section':
			return bucket.section;
		case 'uncategorised':
			return 'not sorted';
		case 'ignored':
			switch (bucket.by.kind) {
				case 'rule':
					return `ignored (${ignoreRuleName(bucket.by.rule)})`;
				case 'pattern':
					return `ignored (pattern ${bucket.by.pattern})`;
				case 'agent':
					return `ignored by the agent (${quotedAgentText(bucket.by.reason, 60)})`;
			}
	}
}
