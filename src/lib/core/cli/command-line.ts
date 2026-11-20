/**
 * The `diff-delver` command line (DESIGN 3), read into what to do. Nothing here
 * asks a question: a command that cannot be read says what was wrong and how to
 * see what the command can do.
 */
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import {
	describeInvalidSourceSpec,
	parseGitSourceSpec,
	type GitSourceSpec
} from '../sources/git-source-spec.ts';

export type Command =
	/** No command: open what is most likely to be reviewed in this folder. */
	| { readonly kind: 'start' }
	/** One source, as `parseGitSourceSpec` reads it. */
	| { readonly kind: 'open'; readonly source: GitSourceSpec }
	/** The daemon, in the foreground, until it is stopped. */
	| { readonly kind: 'serve' }
	/** Stops the daemon of the data folder. */
	| { readonly kind: 'stop' }
	| { readonly kind: 'help' }
	| { readonly kind: 'version' };

export interface Invocation {
	readonly command: Command;
	/** Print the address instead of opening a browser. */
	readonly noOpen: boolean;
	/** The data folder as given, relative to the folder the command runs in, or undefined for the default. */
	readonly dataDirectory: string | undefined;
}

/** The environment variable that names the data folder, when `--data-directory` is not given. */
export const DATA_DIRECTORY_VARIABLE = 'DIFF_DELVER_DATA_DIRECTORY';

export type CommandLineError =
	| { readonly kind: 'UnknownCommand'; readonly word: string }
	| { readonly kind: 'UnknownOption'; readonly option: string }
	| { readonly kind: 'MissingSource' }
	| { readonly kind: 'ExtraArgument'; readonly argument: string }
	| { readonly kind: 'MissingOptionValue'; readonly option: string }
	| {
			readonly kind: 'InvalidSource';
			readonly message: ReviewerMessage;
	  };

const COMMANDS = ['open', 'serve', 'stop', 'help', 'version'] as const;

/** Reads the arguments after the program's name. */
export function parseCommandLine(args: readonly string[]): Result<Invocation, CommandLineError> {
	let noOpen = false;
	let dataDirectory: string | undefined;
	let help = false;
	let version = false;
	const words: string[] = [];
	let onlyWords = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? '';
		if (onlyWords || !arg.startsWith('-') || arg === '-') {
			words.push(arg);
			continue;
		}
		if (arg === '--') {
			onlyWords = true;
			continue;
		}
		if (arg === '--no-open') {
			noOpen = true;
		} else if (arg === '--help' || arg === '-h') {
			help = true;
		} else if (arg === '--version' || arg === '-v') {
			version = true;
		} else if (arg === '--data-directory') {
			const next = args[i + 1];
			if (next === undefined || next === '') {
				return err({ kind: 'MissingOptionValue', option: arg });
			}
			dataDirectory = next;
			i += 1;
		} else if (arg.startsWith('--data-directory=')) {
			const given = arg.slice('--data-directory='.length);
			if (given === '') return err({ kind: 'MissingOptionValue', option: '--data-directory' });
			dataDirectory = given;
		} else if (words[0] === 'open' && words.length === 1 && parseGitSourceSpec(arg).ok) {
			// `diff-delver open --staged`: a source that looks like an option.
			words.push(arg);
		} else {
			return err({ kind: 'UnknownOption', option: arg });
		}
	}
	const done = (command: Command): Result<Invocation, CommandLineError> =>
		ok({ command, noOpen, dataDirectory });
	if (help) return done({ kind: 'help' });
	if (version) return done({ kind: 'version' });

	const [first, ...rest] = words;
	if (first === undefined) return done({ kind: 'start' });
	const known = COMMANDS.find((name) => name === first);
	if (known === undefined) return err({ kind: 'UnknownCommand', word: first });
	switch (known) {
		case 'open': {
			const [source, ...extra] = rest;
			if (source === undefined) return err({ kind: 'MissingSource' });
			if (extra[0] !== undefined) return err({ kind: 'ExtraArgument', argument: extra[0] });
			const spec = parseGitSourceSpec(source);
			if (!spec.ok) {
				return err({ kind: 'InvalidSource', message: describeInvalidSourceSpec(spec.error) });
			}
			return done({ kind: 'open', source: spec.value });
		}
		case 'serve':
		case 'stop':
		case 'help':
		case 'version': {
			if (rest[0] !== undefined) return err({ kind: 'ExtraArgument', argument: rest[0] });
			return done({ kind: known });
		}
	}
}

const SEE_HELP = 'Run diff-delver --help to see what it can do.';

/** What was wrong with the command line, and what to do next. */
export function describeCommandLineError(error: CommandLineError): ReviewerMessage {
	switch (error.kind) {
		case 'UnknownCommand':
			return reviewerMessage(
				`diff delver has no command "${error.word}". To review a commit or a range, run diff-delver open ${error.word}. ${SEE_HELP}`
			);
		case 'UnknownOption':
			return reviewerMessage(`diff delver has no option ${error.option}. ${SEE_HELP}`);
		case 'MissingSource':
			return reviewerMessage(
				'diff-delver open needs what to open: a commit (such as HEAD), two branches to compare (such as main...feature-x), staged or working-tree.'
			);
		case 'ExtraArgument':
			return reviewerMessage(
				`diff delver did not expect "${error.argument}" there. To open a range, write it as one word, such as main...feature-x. ${SEE_HELP}`
			);
		case 'MissingOptionValue':
			return reviewerMessage(
				`${error.option} needs a folder after it, such as ${error.option} ~/diff-delver-data.`
			);
		case 'InvalidSource':
			return error.message;
	}
}

/** What `diff-delver --help` prints. */
export const HELP_TEXT = `diff delver: review a diff, sorted into sections by an agent or by hand.

Usage:
  diff-delver                 Open the changes in this repository that are most
                              likely to be reviewed, in your browser.
  diff-delver open <source>   Open one source: working-tree (uncommitted changes),
                              staged, a commit such as HEAD or abc1234, or two
                              branches to compare, such as main...feature-x.
  diff-delver serve           Run diff delver in this terminal until Ctrl+C.
  diff-delver stop            Stop diff delver if it is running.

Options:
  --no-open                   Print the address instead of opening a browser.
                              The address works once, within two minutes.
  --data-directory <folder>   Keep diff delver's data in this folder. The
                              ${DATA_DIRECTORY_VARIABLE} environment variable does
                              the same.
  --help, -h                  Show this help.
  --version, -v               Show which version this is.

diff delver never writes to the repository you review.`;
