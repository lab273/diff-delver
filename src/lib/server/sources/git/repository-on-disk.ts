/**
 * Which repository a folder is in, found from the file system alone, without
 * running git there. git reads a repository's own config as soon as it runs in
 * it, and that config can name commands git then runs (a clean filter, run by
 * `git add`); so before diff delver runs git in a folder that an agent named,
 * it checks, by reading files only, that the folder is in a repository the
 * person chose (`create_report`'s `directory`, DESIGN 7.1).
 *
 * The search follows git's own discovery (`setup_git_directory`): from the
 * folder, with links resolved as git's working directory has them, up to the
 * root, the first level with a `.git` (a folder, or a file `gitdir: <path>`) or
 * that is itself a git directory. It is stricter than git where the two could
 * differ: any `.git` stops it, valid or not, and so does any folder with a
 * `HEAD` beside `objects` or `refs`. So when it finds a repository, git would
 * find that one or none; it never finds one git would pass by for another.
 *
 * The repository is named as `locateRepository` names it: its common git
 * directory (`commondir`, for a linked worktree), with links resolved.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';

export interface RepositoryOnDisk {
	/** Where git would run for it: the top of its working tree, or the git directory of a bare one. */
	readonly top: AbsolutePath;
	/** Its common git directory, with links resolved: what identifies the repository. */
	readonly commonDir: AbsolutePath;
}

async function kindOf(path: string): Promise<'file' | 'folder' | 'other' | undefined> {
	try {
		const found = await stat(path);
		return found.isFile() ? 'file' : found.isDirectory() ? 'folder' : 'other';
	} catch {
		return undefined;
	}
}

async function realPath(path: string): Promise<AbsolutePath | undefined> {
	try {
		const real = parseAbsolutePath(await realpath(path));
		return real.ok ? real.value : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a folder could be a git directory: stricter than git, which needs all three. */
async function mayBeGitDirectory(folder: string): Promise<boolean> {
	if ((await kindOf(join(folder, 'HEAD'))) === undefined) return false;
	return (
		(await kindOf(join(folder, 'objects'))) !== undefined ||
		(await kindOf(join(folder, 'refs'))) !== undefined
	);
}

/** The git directory a `.git` entry points at, or undefined when it points nowhere that can be read. */
async function gitDirectoryOf(
	dotGit: string,
	kind: 'file' | 'folder' | 'other'
): Promise<string | undefined> {
	switch (kind) {
		case 'folder':
			return dotGit;
		case 'other':
			return undefined;
		case 'file': {
			let text: string;
			try {
				text = await readFile(dotGit, 'utf8');
			} catch {
				return undefined;
			}
			const match = /^gitdir: (.+?)\r?\n?$/.exec(text);
			return match?.[1] === undefined ? undefined : resolve(dirname(dotGit), match[1]);
		}
	}
}

/** A git directory's common directory: where its `commondir` file points, or itself. */
async function commonDirectoryOf(gitDir: string): Promise<AbsolutePath | undefined> {
	let common = gitDir;
	try {
		const text = (await readFile(join(gitDir, 'commondir'), 'utf8')).replace(/\r?\n$/, '');
		if (text !== '') common = resolve(gitDir, text);
	} catch {
		// No commondir: the git directory is its own.
	}
	return realPath(common);
}

/**
 * The repository `directory` is in, by the files alone, or undefined when
 * there is none that git would certainly find: no repository, a `.git` that
 * points nowhere, or a folder that cannot be read.
 */
export async function repositoryOnDisk(
	directory: AbsolutePath
): Promise<RepositoryOnDisk | undefined> {
	const start = await realPath(directory);
	if (start === undefined || (await kindOf(start)) !== 'folder') return undefined;
	for (let folder: string = start; ; folder = dirname(folder)) {
		const dotGit = join(folder, '.git');
		const kind = await kindOf(dotGit);
		if (kind !== undefined) {
			const gitDir = await gitDirectoryOf(dotGit, kind);
			const commonDir = gitDir === undefined ? undefined : await commonDirectoryOf(gitDir);
			const top = parseAbsolutePath(folder);
			return commonDir === undefined || !top.ok ? undefined : { top: top.value, commonDir };
		}
		if (await mayBeGitDirectory(folder)) {
			const commonDir = await commonDirectoryOf(folder);
			const top = parseAbsolutePath(folder);
			return commonDir === undefined || !top.ok ? undefined : { top: top.value, commonDir };
		}
		if (dirname(folder) === folder) return undefined;
	}
}
