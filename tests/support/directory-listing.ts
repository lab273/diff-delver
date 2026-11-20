/**
 * A complete listing of a directory, for proving that an operation wrote nothing
 * to it: every entry with its kind, permissions, size, modification and change
 * times in nanoseconds, inode, and content hash (or link target).
 *
 * Directory times are listed too, so a file that was created and removed again,
 * such as a lock file, shows up as a changed parent directory. Access times are
 * not, since reading a file may change them. Paths are read as bytes, so names
 * that are not UTF-8 are listed exactly.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';

function shown(path: Buffer): string {
	return JSON.stringify(path.toString('latin1'));
}

/** One line per entry, sorted, the root first as `"."`. */
export async function listDirectory(root: string): Promise<readonly string[]> {
	const lines: string[] = [];
	const rootBytes = Buffer.from(root);
	async function walk(path: Buffer, relative: Buffer): Promise<void> {
		const info = await lstat(path, { bigint: true });
		const kind = info.isDirectory()
			? 'dir'
			: info.isSymbolicLink()
				? 'link'
				: info.isFile()
					? 'file'
					: 'other';
		let content = '';
		if (info.isFile())
			content = createHash('sha256')
				.update(await readFile(path))
				.digest('hex');
		if (info.isSymbolicLink()) content = shown(await readlink(path, { encoding: 'buffer' }));
		lines.push(
			[
				relative.length === 0 ? '"."' : shown(relative),
				kind,
				info.mode.toString(8),
				String(info.size),
				String(info.mtimeNs),
				String(info.ctimeNs),
				String(info.ino),
				content
			].join('\t')
		);
		if (!info.isDirectory()) return;
		const names = await readdir(path, { encoding: 'buffer' });
		for (const name of names.toSorted((a, b) => Buffer.compare(a, b))) {
			const child = Buffer.concat([path, Buffer.from('/'), name]);
			await walk(
				child,
				relative.length === 0 ? name : Buffer.concat([relative, Buffer.from('/'), name])
			);
		}
	}
	await walk(rootBytes, Buffer.alloc(0));
	return lines;
}

/**
 * Runs `action` and returns the listings of every directory before and after it,
 * so a test can expect them to be equal. The action's result is returned too.
 */
export async function listingsAround<T>(
	directories: readonly string[],
	action: () => Promise<T>
): Promise<{
	readonly before: readonly (readonly string[])[];
	readonly after: readonly (readonly string[])[];
	readonly result: T;
}> {
	const before = await Promise.all(directories.map(listDirectory));
	const result = await action();
	const after = await Promise.all(directories.map(listDirectory));
	return { before, after, result };
}
