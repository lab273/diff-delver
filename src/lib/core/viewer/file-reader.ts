/** The reader fetches and draws one page at a time. */
export const FILE_PAGE_LINES = 200;
export const MOST_FILE_BYTES = 4_000_000;
export const FILE_MATCHES = 30;
export const FILE_QUERY_LENGTH = 200;

/** Lower scores are better. Prefer the filename, then compact matches in the path. */
export function fileMatchScore(path: string, query: string): number {
	if (query === '') return 0;
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (name.includes(query)) return 2;
	if (path.includes(query)) return 3;
	let at = 0;
	let first = -1;
	for (const character of query) {
		const found = path.indexOf(character, at);
		if (found === -1) return Infinity;
		if (first === -1) first = found;
		at = found + character.length;
	}
	return 4 + at - first;
}
