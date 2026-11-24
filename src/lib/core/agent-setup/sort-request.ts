/**
 * What a person pastes to their coding agent to have it sort the Delve they are
 * looking at, and the command that takes a terminal to its repository.
 *
 * The sentence names the report by its id, which every tool but `create_report`
 * takes and which is the same wherever the agent was started: in the Delve's
 * repository, in another folder of it, or anywhere else. It says not to create
 * a report, since `create_report` opens the repository the agent was started
 * in, which may be another one, and would bring this report up to date under
 * the page; and it names the tool to begin with. The source in words and the
 * repository's name are there for the person and the agent to recognise it by.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import { visibleText } from '../hidden-characters.ts';
import type { ReportId } from '../report-id.tiny.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import { shellCommand } from './shell-words.ts';
import { textToCopy, type TextToCopy } from './text-to-copy.tiny.ts';

export interface DelveToSort {
	readonly id: ReportId;
	/** The source in plain words: "Uncommitted changes". */
	readonly title: ReviewerMessage;
	/** The repository's folder name. */
	readonly repository: ReviewerMessage;
}

/** The sentence. What cannot be seen in a title is written out, so nothing unseen is pasted. */
export function sortRequest(delve: DelveToSort): TextToCopy {
	const what = `“${visibleText(delve.title)}” in ${visibleText(delve.repository)}`;
	return textToCopy(
		`Sort diff delver report ${delve.id} into sections for review: ${what}. ` +
			`The report already exists, so do not create another one. ` +
			`Start with get_manifest for report ${delve.id}.`
	);
}

/** The command that takes a terminal to the Delve's repository, to start the agent there. */
export function goToFolderCommand(
	folder: AbsolutePath,
	home: AbsolutePath | undefined
): TextToCopy {
	return textToCopy(shellCommand(['cd', folder], home));
}
