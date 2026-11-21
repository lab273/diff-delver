import { escapedRepoPath, type EscapedPath } from './escaped-path.tiny.ts';
import { escapeCharacter, isHiddenCharacter } from './hidden-characters.ts';
import type { RepoPath } from './repo-path.tiny.ts';
import type { Tiny } from './tiny.ts';

/**
 * A repository path as a person is shown it, on the page, in what is read out
 * and in the command's output. Made only by `shownPath`, here.
 */
export type ShownPath = Tiny<string, 'ShownPath'>;

/** A piece of a shown path: text, or a character that cannot be seen, written as its escape. */
export type PathPiece =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'escape'; readonly shown: string };

/**
 * The pieces of a path as a person is shown it: its escaped form
 * (`escapedRepoPath`: odd bytes as `\xHH`, backslashes doubled where needed),
 * with each character that is not seen, or turns text round, written as an
 * escape as code's are (`hidden-characters.ts`). So `report` U+202E `txt.exe`
 * never reads as "reportexe.txt", nor `a` U+200B `b.txt` as "ab.txt".
 *
 * No two paths are shown alike: a path written with a backslash of its own
 * has it doubled, so its text can never pass for an escape here.
 */
export function pathPieces(path: EscapedPath): readonly PathPiece[] {
	const pieces: PathPiece[] = [];
	let plain = '';
	for (const character of path) {
		if (!isHiddenCharacter(character)) {
			plain += character;
			continue;
		}
		if (plain !== '') pieces.push({ kind: 'text', text: plain });
		plain = '';
		pieces.push({ kind: 'escape', shown: escapeCharacter(character) });
	}
	if (plain !== '') pieces.push({ kind: 'text', text: plain });
	return pieces;
}

/** A path as a person is shown it, as text (see `pathPieces`). */
export function shownPath(path: EscapedPath): ShownPath {
	return pathPieces(path)
		.map((piece) => (piece.kind === 'text' ? piece.text : piece.shown))
		.join('') as ShownPath;
}

/** A repository path as a person is shown it. */
export function shownRepoPath(path: RepoPath): ShownPath {
	return shownPath(escapedRepoPath(path));
}
