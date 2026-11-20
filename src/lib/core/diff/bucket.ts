/**
 * Where a change unit sits (DESIGN 4.2): one section, `Ignored`, or
 * `Uncategorised`. Exactly one.
 */
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { GlobPattern } from '../glob-pattern.tiny.ts';
import type { SectionId } from '../section-id.tiny.ts';
import type { IgnoreRuleId } from './path-rules.ts';

/** Who put a unit in `Ignored`, and why. */
export type IgnoredBy =
	| { readonly kind: 'rule'; readonly rule: IgnoreRuleId }
	| { readonly kind: 'pattern'; readonly pattern: GlobPattern }
	| { readonly kind: 'agent'; readonly reason: AgentMarkdown };

export type Bucket =
	| { readonly kind: 'section'; readonly section: SectionId }
	| { readonly kind: 'ignored'; readonly by: IgnoredBy }
	| { readonly kind: 'uncategorised' };

export const UNCATEGORISED: Bucket = { kind: 'uncategorised' };

export function sectionBucket(section: SectionId): Bucket {
	return { kind: 'section', section };
}

export function ignoredBucket(by: IgnoredBy): Bucket {
	return { kind: 'ignored', by };
}

export function sameBucket(a: Bucket, b: Bucket): boolean {
	switch (a.kind) {
		case 'section':
			return b.kind === 'section' && a.section === b.section;
		case 'ignored':
			return b.kind === 'ignored' && sameIgnoredBy(a.by, b.by);
		case 'uncategorised':
			return b.kind === 'uncategorised';
	}
}

function sameIgnoredBy(a: IgnoredBy, b: IgnoredBy): boolean {
	switch (a.kind) {
		case 'rule':
			return b.kind === 'rule' && a.rule === b.rule;
		case 'pattern':
			return b.kind === 'pattern' && a.pattern === b.pattern;
		case 'agent':
			return b.kind === 'agent' && a.reason === b.reason;
	}
}
