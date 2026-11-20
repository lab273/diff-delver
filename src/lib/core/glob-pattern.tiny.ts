import { globToRegExp, type GlobProblem } from './glob.ts';
import { err, ok, type Result } from './result.ts';
import type { RepoPath } from './repo-path.tiny.ts';
import type { Tiny } from './tiny.ts';

/** A glob over repository paths that compiles. The syntax is described in `glob.ts`. */
export type GlobPattern = Tiny<string, 'GlobPattern'>;

export interface InvalidGlobPattern {
	readonly kind: 'InvalidGlobPattern';
	readonly value: string;
	readonly problem: GlobProblem;
}

export function parseGlobPattern(value: string): Result<GlobPattern, InvalidGlobPattern> {
	const compiled = globToRegExp(value);
	if (!compiled.ok) return err({ kind: 'InvalidGlobPattern', value, problem: compiled.error });
	return ok(value as GlobPattern);
}

/** Tests paths against a pattern. Compile once and reuse it for many paths. */
export type GlobMatcher = (path: RepoPath) => boolean;

export function compileGlob(pattern: GlobPattern): GlobMatcher {
	const compiled = globToRegExp(pattern);
	if (!compiled.ok) throw new Error(`A parsed glob failed to compile: ${pattern}`);
	const regex = compiled.value;
	return (path) => regex.test(path);
}
