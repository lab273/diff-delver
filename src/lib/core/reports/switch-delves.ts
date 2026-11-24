/**
 * Moving between Delves (DESIGN 8.1): which repositories the list of Delves
 * offers to open something new in, which Delves the panel on a Delve's page
 * lists, and finding one of them by name. Pure, so the list of Delves and the
 * panel offer the same things.
 *
 * A source that is not a local repository, such as a pull request, would be
 * offered beside "Choose commits or a branch": a repository here is the place
 * such an offer hangs from.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import { foldCase } from '../search/find-text.ts';

/** What of a Delve tells which repository it is of. */
export interface DelveOfRepository {
	/** The repository's folder name, as people are shown it. */
	readonly repository: ReviewerMessage;
	/** The folder the Delve was opened in. */
	readonly directory: AbsolutePath;
}

/** A repository diff delver knows, because a Delve was opened in it. */
export interface KnownRepository extends DelveOfRepository {
	/** Another known repository has the same folder name, so its name alone does not say which. */
	readonly sameName: boolean;
}

/**
 * The repositories of these Delves, each once, in the order their Delves come
 * (most recently active first, as the list gives them).
 */
export function knownRepositories(delves: readonly DelveOfRepository[]): KnownRepository[] {
	const byDirectory = new Map<AbsolutePath, DelveOfRepository>();
	const named = new Map<ReviewerMessage, number>();
	for (const { repository, directory } of delves) {
		if (byDirectory.has(directory)) continue;
		byDirectory.set(directory, { repository, directory });
		named.set(repository, (named.get(repository) ?? 0) + 1);
	}
	return [...byDirectory.values()].map((known) => ({
		...known,
		sameName: (named.get(known.repository) ?? 0) > 1
	}));
}

/** The panel has a box to find a Delve by name when it lists more than this many. */
export const DELVES_LISTED_WITHOUT_FINDING = 5;

/** Whether a list of this many Delves gets a box to find one by name. */
export function offersFinding(count: number): boolean {
	return count > DELVES_LISTED_WITHOUT_FINDING;
}

/**
 * The Delves whose title or repository holds every word typed, in the order
 * given. Case does not matter for A to Z, as in the diff's own search; nothing
 * typed finds them all.
 */
export function findDelves<
	D extends { readonly title: ReviewerMessage; readonly repository: ReviewerMessage }
>(delves: readonly D[], typed: string): D[] {
	const words = foldCase(typed)
		.split(/\s+/u)
		.filter((word) => word !== '');
	return delves.filter((delve) => {
		const text = foldCase(`${delve.title} ${delve.repository}`);
		return words.every((word) => text.includes(word));
	});
}
