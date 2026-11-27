<!--
	A diff's page: what it is, how big and how far its review has got, whether
	its files have changed (with Update) or it is closed, what the last update
	did, anything left out of it; then the diff itself, group by group in
	reading order (or every file once), each file's part with its lines, ticked
	as the reviewer reads, with the next part to read always one key or one
	button away.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto, invalidate } from '$app/navigation';
	import { onDestroy, tick, untrack } from 'svelte';
	import { page as shownPage } from '$app/state';
	import {
		compareModeName,
		nextCompareMode,
		type CompareMode
	} from '#lib/core/image/compare-modes.ts';
	import { describeApiError } from '#lib/api/client.ts';
	import type {
		ChangeCheckResponse,
		DiffPage,
		DraftCommentView,
		EarlierThreadView,
		NextSourceOffer
	} from '#lib/api/schemas.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import { parseEscapedPath, type EscapedPath } from '#lib/core/path-bytes.ts';
	import { parseSide, type Side } from '#lib/core/side.tiny.ts';
	import type { LineNumber } from '#lib/core/line-number.tiny.ts';
	import FileOpener from '#lib/ui/viewer/FileOpener.svelte';
	import { delveSwitcher } from '#lib/ui/delve-switcher.svelte.ts';
	import FileReader from '#lib/ui/viewer/FileReader.svelte';
	import type { FileMatch } from '#lib/api/schemas.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import {
		parseRevisionNumber,
		previousRevisionNumber,
		type RevisionNumber
	} from '#lib/core/revision-number.tiny.ts';
	import Notice from '#lib/ui/Notice.svelte';
	import { ChangeChecks, type Shown } from '#lib/ui/change-checks.ts';
	import { pageClient } from '#lib/ui/client.ts';
	import type { FileView, GroupKeyView, TallyView } from '#lib/api/schemas.ts';
	import { countOf, describeChanges, describeTally, formatCount } from '#lib/core/viewer/words.ts';
	import { nextShown, previousShown } from '#lib/core/viewer/reading-order.ts';
	import { describeLeftToRead, type WritingPlace } from '#lib/core/viewer/reading-places.ts';
	import { PageMover, type Move } from '#lib/ui/viewer/page-mover.ts';
	import { parsePartIndex, type PartIndex } from '#lib/core/part-index.tiny.ts';
	import type { OrderStep } from '#lib/core/order-step.tiny.ts';
	import FileList from '#lib/ui/viewer/FileList.svelte';
	import SectionFiles from '#lib/ui/viewer/SectionFiles.svelte';
	import { collapseReviewedPart } from '#lib/ui/viewer/collapse-reviewed.ts';
	import { SvelteSet } from 'svelte/reactivity';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import CommentList from '#lib/ui/viewer/CommentList.svelte';
	import AgentNotes from '#lib/ui/viewer/AgentNotes.svelte';
	import EarlierThreads from '#lib/ui/viewer/EarlierThreads.svelte';
	import AgentRequest from '#lib/ui/viewer/AgentRequest.svelte';
	import FinishReview from '#lib/ui/viewer/FinishReview.svelte';
	import OverallReview from '#lib/ui/viewer/OverallReview.svelte';
	import { Comments, Writing, type CommentPlace } from '#lib/ui/viewer/comments.svelte.ts';
	import { keptComments } from '#lib/ui/viewer/kept-comments.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import AgentMarkdown from '#lib/ui/viewer/AgentMarkdown.svelte';
	import Part from '#lib/ui/viewer/Part.svelte';
	import SortWithAgent from '#lib/ui/viewer/SortWithAgent.svelte';
	import TickRefused from '#lib/ui/viewer/TickRefused.svelte';
	import ProgressBar from '#lib/ui/viewer/ProgressBar.svelte';
	import Shortcuts from '#lib/ui/viewer/Shortcuts.svelte';
	import { actsOnRepeat, isFindKey, shortcutOf, type KeyPress } from '#lib/ui/viewer/keys.ts';
	import SearchBar from '#lib/ui/viewer/SearchBar.svelte';
	import type { CurrentMatch } from '#lib/ui/viewer/search.svelte.ts';
	import {
		bookmarkDestination,
		bookmarkedRow,
		lineInView,
		markedLine,
		readingLines,
		rowInView,
		readBookmark,
		saveBookmark,
		type Bookmark,
		type BookmarkDestination,
		type BookmarkLine
	} from '#lib/ui/viewer/bookmark.ts';
	import { wholeHunkHidden } from '#lib/ui/viewer/white-space-notice.ts';
	import { whenReaderMoves } from '#lib/ui/viewer/reader-input.ts';
	import {
		done,
		NEXT_BATCH,
		partly,
		showTally,
		Viewer,
		type GroupInfo,
		type PartState,
		type TickTarget
	} from '#lib/ui/viewer/viewer.svelte.ts';
	import { withSetting, type Layout, type SettingChange } from '#lib/core/settings.ts';
	import { parseSourceSpec } from '#lib/core/sources/source-spec.ts';
	import type { PullRequestRef } from '#lib/core/github/pull-request.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Check =
		| { readonly kind: 'checking' }
		| ChangeCheckResponse
		| { readonly kind: 'failed'; readonly message: string };
	let check: Check = $state({ kind: 'checking' });
	let problem = $state('');
	let busy = $state(false);

	/** Wide enough for two sides of code next to each other, with the rail beside them. */
	const WIDE_ENOUGH = '(min-width: 50rem)';

	/** Once a minute while the page is in view, besides whenever the person comes back to it. */
	const LOOK_AGAIN_EVERY = 60_000;
	const REFRESH_REVIEW_EVERY = 5_000;
	const UPDATED_HEADING = 'updated-heading';
	const PAGE_HEADING = 'page-heading';

	const checks = new ChangeChecks();

	function shown(): Shown {
		return { id: data.id, version: data.loaded.ok ? data.loaded.value.summary.version : undefined };
	}

	/**
	 * Asks whether this diff has a newer version than the page shows, and if not,
	 * whether its files have changed. Looking again in the background keeps what
	 * is shown when the answer cannot be had, rather than flickering, and is not
	 * done while a check is under way. An answer for a diff or version the page
	 * no longer shows is dropped (`change-checks.ts`).
	 */
	async function checkForChanges(quietly = false): Promise<void> {
		// As of a finished review the page shows the past: nothing is checked, GitHub included.
		if (data.requestedReview !== null) return;
		const ticket = checks.start(shown(), quietly);
		if (ticket === undefined) return;
		const checked = await pageClient().checkForChanges(ticket.shown.id, ticket.shown.version);
		if (!checks.finish(ticket, shown())) return;
		if (checked.ok) check = checked.value;
		else if (!quietly) check = { kind: 'failed', message: describeApiError(checked.error) };
	}

	// Again for each diff and version this page shows: opening another one reuses the page.
	$effect(() => {
		void shown();
		check = { kind: 'checking' };
		void checkForChanges();
	});

	// Changes to the source are offered to the reader. Agent writing, sorting
	// and ticks from another page appear on the version the reader already sees.
	$effect(() => {
		const refresh = (): void => {
			if (document.visibilityState === 'visible' && !busy) void refreshReview();
		};
		const again = (): void => {
			if (document.visibilityState !== 'visible' || busy) return;
			void checkForChanges(true);
			refresh();
		};
		window.addEventListener('focus', again);
		document.addEventListener('visibilitychange', again);
		const checkTimer = setInterval(again, LOOK_AGAIN_EVERY);
		const reviewTimer = setInterval(refresh, REFRESH_REVIEW_EVERY);
		return () => {
			window.removeEventListener('focus', again);
			document.removeEventListener('visibilitychange', again);
			clearInterval(checkTimer);
			clearInterval(reviewTimer);
		};
	});

	/** The notices whose buttons act on the whole diff, by their headings' ids, in the order the page shows them. */
	const NOTICE_HEADINGS = [
		'newer-heading',
		'closed-heading',
		'changed-heading',
		'nothing-left-heading'
	];

	/**
	 * Does what a notice's button asks. The buttons stay usable while it runs, so
	 * focus stays on them, and a press meanwhile does nothing. When the button has
	 * gone with its notice, focus goes to the notice that took its place, or to
	 * the page's heading, never to nowhere.
	 */
	async function act(action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
		if (busy) return;
		busy = true;
		problem = '';
		const done = await action();
		busy = false;
		if (!done.ok) problem = done.message ?? '';
		await tick();
		if (document.activeElement !== null && document.activeElement !== document.body) return;
		const notice = NOTICE_HEADINGS.map((id) => document.getElementById(id)).find((h) => h !== null);
		(notice ?? document.getElementById(PAGE_HEADING))?.focus();
	}

	/** Shows the version the page now has and moves focus to what the update did. */
	async function showNewVersion(): Promise<void> {
		if (readerUrl.searchParams.has('version')) {
			await goto(resolve('/diffs/[id]', { id: data.id }), {
				replace: true,
				reset: false,
				invalidate: ['app:diff']
			});
		} else {
			await invalidate('app:diff');
		}
		await tick();
		document.getElementById(UPDATED_HEADING)?.focus();
	}

	async function showNewer(): Promise<void> {
		await act(async () => {
			await showNewVersion();
			return { ok: true };
		});
	}

	async function update(): Promise<void> {
		await act(async () => {
			const updated = await pageClient().updateDiff(data.id);
			if (!updated.ok) return { ok: false, message: describeApiError(updated.error) };
			switch (updated.value.kind) {
				case 'updated':
					await showNewVersion();
					return { ok: true };
				case 'unchanged':
					check = { kind: 'unchanged' };
					return { ok: true };
				case 'nothing-left':
					check = {
						kind: 'nothing-left',
						reason: updated.value.reason,
						next: updated.value.next
					};
					return { ok: true };
			}
		});
	}

	async function setOpen(open: boolean): Promise<void> {
		await act(async () => {
			const client = pageClient();
			const changed = open ? await client.reopenDiff(data.id) : await client.closeDiff(data.id);
			if (!changed.ok) return { ok: false, message: describeApiError(changed.error) };
			await invalidate('app:diff');
			await checkForChanges();
			return { ok: true };
		});
	}

	async function openNext(next: NextSourceOffer, directory: string): Promise<void> {
		await act(async () => {
			const opened = await pageClient().open({ directory, source: next.source });
			if (!opened.ok) return { ok: false, message: describeApiError(opened.error) };
			if (opened.value.kind === 'nothing') return { ok: false, message: opened.value.reason };
			await goto(resolve('/diffs/[id]', { id: opened.value.diff.id }));
			return { ok: true };
		});
	}

	/** Whether the Delve follows a GitHub pull request, so its banners speak of it and not of files. */
	function followsPullRequest(source: string): boolean {
		const spec = parseSourceSpec(source);
		return spec.ok && spec.value.kind === 'pull-request';
	}

	/** The pull request the Delve follows, if it follows one, to post its reviews to. */
	function pullRequestOf(source: string): PullRequestRef | undefined {
		const spec = parseSourceSpec(source);
		return spec.ok && spec.value.kind === 'pull-request' ? spec.value.pullRequest : undefined;
	}

	function fileCount(count: number): string {
		return count === 1 ? '1 file' : `${String(count)} files`;
	}

	// ── The viewer ──────────────────────────────────────────────────────────────

	// The rest of a large diff is drawn a batch a frame once the first screen is up.
	$effect(() => {
		const shown = viewer;
		if (shown === undefined) return;
		let frame = 0;
		const more = (): void => {
			if (shown.rendered >= shown.parts.length) return;
			shown.rendered = Math.min(shown.parts.length, shown.rendered + NEXT_BATCH);
			frame = requestAnimationFrame(more);
		};
		frame = requestAnimationFrame(more);
		return () => {
			cancelAnimationFrame(frame);
		};
	});

	const EVERYTHING_REVIEWED = 'everything-reviewed';
	/** Every move the page makes on its own, eased into place (`page-mover.ts`). */
	const mover = new PageMover();
	const AGENT_OVERVIEW = 'agent-overview';

	/** Read from the address once, when the page opens: by file, and only what waits. */
	const startByFile = untrack(() => shownPage.url.searchParams.get('view') === 'files');
	const startOnlyWaiting = untrack(() => shownPage.url.searchParams.get('only') === 'unreviewed');

	let byFile = $state(startByFile);
	/** Whether the by-file view has been shown yet: it is made only when first asked for. */
	let fileListMade = $state(startByFile);
	let onlyWaiting = $state(startOnlyWaiting);
	/** How the person likes diffs shown, remembered by diff delver for every diff. */
	let settings = $state(untrack(() => data.settings));
	/** The viewer made last, whose search a newer version's takes over. */
	let lastViewer: Viewer | undefined;
	let refreshed = $state.raw<{ initial: DiffPage; frame: DiffPage }>();
	let staleTick = $state.raw<{
		id: DiffPage['summary']['id'];
		version: DiffPage['summary']['version'];
		message: string;
		part: PartState | undefined;
		group: GroupKeyView | undefined;
	}>();
	let reviewRefresh: Promise<void> | undefined;
	/** A regroup waits for the reviewer to finish choosing lines, or typing a comment. */
	let waitingForComment = $state.raw<{ viewer: Viewer; doing: 'choosing' | 'writing' }>();
	/**
	 * A return to a place under way, which reader input or another return stops:
	 * with the part and offset a regroup is keeping, which a regroup that comes
	 * before it is done keeps in turn, since the page is not settled enough yet
	 * to measure.
	 */
	let viewportRestore:
		| {
				viewer: Viewer;
				stop: () => void;
				place?: { readonly part: PartState; readonly top: number };
		  }
		| undefined;
	/**
	 * What the page loaded of the Delve. Kept apart from `data`, which is made
	 * anew whenever anything in it is asked for again, such as whether this
	 * browser may write comments: the viewer is made again only for a Delve
	 * loaded again, so nothing open or typed is redrawn for less.
	 */
	const loadedDelve = $derived(data.loaded);
	const viewer = $derived.by(() => {
		if (!loadedDelve.ok) return undefined;
		const initial = loadedDelve.value;
		const frame = refreshed?.initial === initial ? refreshed.frame : initial;
		const made = untrack(
			() =>
				new Viewer(
					frame,
					onlyWaiting,
					settings,
					pageClient(),
					lastViewer?.search.handOver(),
					frame === initial ? undefined : lastViewer
				)
		);
		lastViewer = made;
		return made;
	});
	/** The reviewer's questions for the agent asked on another version than the one shown, listed above the diff. */
	const otherVersions = $derived.by(() => {
		const shown = viewer;
		return shown === undefined ? [] : shown.requests.filter((r) => r.version !== shown.version);
	});

	/**
	 * The instructions for having an agent sort this Delve (`SortWithAgent`):
	 * whether they are open, and whether an agent's first sections arrived while
	 * this page was open. They are put away by themselves when those arrive,
	 * since the page then shows what the agent is making; the button stays while
	 * anything is not sorted, and the focus goes to it if it was in the steps.
	 */
	let agentHelpOpen = $state(false);
	let agentStarted = $state(false);
	let sortedBefore: boolean | undefined;
	// Before the page is drawn again, while what had the focus is still there to ask.
	$effect.pre(() => {
		const sorted = viewer?.sorted;
		if (sorted === undefined) return;
		const arrived = sortedBefore === false && sorted;
		sortedBefore = sorted;
		if (!arrived) return;
		const within = untrack(() => agentHelpOpen)
			? document.activeElement?.closest('#agent-help-steps') != null
			: false;
		agentStarted = true;
		agentHelpOpen = false;
		if (!within) return;
		void tick().then(() => {
			const toggle = document.querySelector('[data-agent-help] button');
			if (toggle instanceof HTMLElement) toggle.focus();
		});
	});

	async function refreshReview(force = false): Promise<void> {
		if (reviewRefresh !== undefined && !force) return;
		if (reviewRefresh !== undefined) await reviewRefresh;
		reviewRefresh ??= readReview(force).finally(() => (reviewRefresh = undefined));
		await reviewRefresh;
	}

	$effect(() => {
		if (viewer?.assignmentsChanged) void refreshReview(true);
	});

	$effect(() => {
		const shown = viewer;
		return () => {
			if (viewportRestore?.viewer === shown) viewportRestore?.stop();
		};
	});

	async function readReview(force: boolean): Promise<void> {
		const shown = viewer;
		if (shown === undefined || !data.loaded.ok) return;
		const initial = data.loaded.value;
		const frame = await shown.readRefresh(force);
		if (frame === undefined || viewer !== shown) return;
		if (shown.sameLayout(frame)) {
			waitingForComment = undefined;
			await keepingPlace(() => {
				shown.applyFrame(frame);
			});
			return;
		}
		// A same-version regroup draws every file again. It waits while the
		// reviewer is taking lines, whose numbers would be replaced under them,
		// and while they type a comment among the lines, whose box would be too.
		// The old snapshot still accepts a comment on those lines.
		const doing =
			document.querySelector('[data-selecting-comment]:not([hidden] *)') !== null
				? 'choosing'
				: document.activeElement?.closest('article.part [data-writing-comment]') != null
					? 'writing'
					: undefined;
		if (doing !== undefined) {
			waitingForComment = { viewer: shown, doing };
			return;
		}
		waitingForComment = undefined;

		// A move under way is where the reader is going: keep that place.
		mover.settle();
		const active = document.activeElement;
		const focused = partAtElement(shown, active);
		const heading = active?.closest('section.group')?.querySelector('h2')?.id;
		const keeping = viewportRestore?.viewer === shown ? viewportRestore.place : undefined;
		const atTop = keeping === undefined && window.scrollY === 0;
		const anchor = atTop || keeping !== undefined ? undefined : viewportPart(shown);
		const before = keeping?.part ?? partAtElement(shown, anchor);
		const top = keeping?.top ?? anchor?.getBoundingClientRect().top;
		// The line the reader was in, so its new part is found by what it holds: a
		// regroup can move a file's lines into another part of it, as a reading order does.
		const seen =
			anchor === undefined
				? null
				: lineInView(
						anchor,
						Math.max(
							stickyTop,
							anchor.querySelector('header')?.getBoundingClientRect().bottom ?? 0
						),
						window.innerHeight
					);
		refreshed = { initial, frame };
		const next = viewer;
		let anchorAt = before === undefined ? undefined : next.nearestPart(before);
		if (before !== undefined && seen !== null) {
			const files = next.parts.filter((p) => p.part.path === before.part.path);
			if (files.length > 1) {
				const home = await linesHome(next, files, seen, () => viewer === next);
				if (viewer !== next) return;
				if (home?.priority === 3) anchorAt = home.part.index;
			}
		}
		const focusAt =
			focused === undefined || focused === before ? anchorAt : next.nearestPart(focused);
		const destination = anchorAt === undefined ? undefined : next.parts[anchorAt];
		let waitingForHeight = false;
		if (before !== undefined && destination?.part.path === before.part.path) {
			destination.open = before.open;
			destination.showLarge = before.showLarge;
			if (top !== undefined) {
				// A large part's placeholder cannot hold a deep offset at all.
				waitingForHeight = top < 0 && before.showLarge && destination.open;
				void restorePlace(next, destination, top);
			}
		}
		if (anchorAt !== undefined) next.drawUpTo(anchorAt);
		if (focusAt !== undefined) next.drawUpTo(focusAt);
		await tick();
		if (viewer !== next) return;
		const anchorNow = anchorAt === undefined ? null : document.getElementById(`part-${anchorAt}`);
		if (atTop) {
			window.scrollTo(0, 0);
		} else if (anchorNow !== null && top !== undefined && !waitingForHeight) {
			// A neighbouring file gives focus somewhere to go when the old one is
			// gone. Its contents cannot stand in for the old viewport offset.
			if (destination?.part.path === before?.part.path) {
				window.scrollBy(0, anchorNow.getBoundingClientRect().top - top);
			}
		}
		if (focusLost() && (focused !== undefined || heading !== undefined)) {
			const headingNow = heading === undefined ? null : document.getElementById(heading);
			const target =
				(focused === undefined ? headingNow : null) ??
				(focusAt === undefined ? null : document.getElementById(`part-${focusAt}-toggle`)) ??
				document.getElementById(PAGE_HEADING);
			target?.focus({ preventScroll: true });
		}
	}

	/**
	 * Puts the part the reader was in back at its offset once it, and the open
	 * parts near the screen, have their lines: until then their loading
	 * placeholders are shorter than they will be, so an offset kept against them
	 * drifts as those above fill, and the page may be too short to scroll to it
	 * until those below do. A large part's table and its chunk placeholders are
	 * laid out for it. User input and further handovers cancel the restoration
	 * without cancelling the parts' ordinary loads.
	 */
	async function restorePlace(shown: Viewer, part: PartState, top: number): Promise<void> {
		viewportRestore?.stop();
		part.measuring = true;
		const attempt = { stopped: false };
		const stop = (): void => {
			attempt.stopped = true;
			part.measuring = false;
			stopListening();
			if (viewportRestore?.stop === stop) viewportRestore = undefined;
		};
		const stopListening = whenReaderMoves(window, stop);
		viewportRestore = { viewer: shown, stop, place: { part, top } };
		let keptForNext = false;
		try {
			const filling = (): PartState[] =>
				shown.parts.filter(
					(p) =>
						p.open &&
						!shown.isLarge(p) &&
						(p === part || p.near) &&
						(p.lines.kind === 'waiting' || p.lines.kind === 'loading')
				);
			for (let waiting = filling(); waiting.length > 0; waiting = filling()) {
				await Promise.all(waiting.map((p) => shown.load(p.index)));
				await tick();
				if (attempt.stopped || viewer !== shown) return;
			}
			if (attempt.stopped || viewer !== shown) return;
			const destination = document.getElementById(`part-${part.index}`);
			if (destination === null || !shown.shows(part.index)) return;
			const box = destination.getBoundingClientRect();
			if (box.height === 0) return;
			if (part.open && !shown.isLarge(part) && part.lines.kind !== 'loaded') {
				// Its lines were refused, most often because the sorting moved on
				// again: the regroup that follows keeps this place, which the short
				// notice in their stead cannot show.
				window.scrollBy(0, box.top - top);
				keptForNext = true;
				return;
			}
			// The same offset, unless the part would then be above the screen; a
			// large part, or one shorter now, keeps its end in reach.
			const exact = !part.showLarge && box.height + top > 0;
			const offset = exact ? top : Math.max(top, Math.min(0, window.innerHeight - box.height));
			window.scrollBy(0, box.top - offset);
		} finally {
			if (!keptForNext) stop();
		}
	}

	function onScreen(element: HTMLElement): boolean {
		const box = element.getBoundingClientRect();
		return box.bottom > 0 && box.top < window.innerHeight;
	}

	function viewportPart(shown: Viewer | undefined): HTMLElement | undefined {
		const current = shown?.current;
		const reading =
			current === undefined ? null : document.getElementById(`part-${String(current)}`);
		if (reading !== null && onScreen(reading)) return reading;
		return [...document.querySelectorAll<HTMLElement>('article.part')].find(onScreen);
	}

	function partAtElement(shown: Viewer, element: Element | null | undefined) {
		const part = element?.closest('article.part');
		if (part === null || part === undefined) return undefined;
		const index = parsePartIndex(Number(part.id.replace(/^part-/, '')));
		return index.ok ? shown.parts[index.value] : undefined;
	}

	/** Whether the window is wide enough for two sides; a narrower one shows one column, nothing lost. */
	let wide = $state(true);
	$effect(() => {
		const query = window.matchMedia(WIDE_ENOUGH);
		wide = query.matches;
		const changed = (): void => {
			wide = query.matches;
		};
		query.addEventListener('change', changed);
		return () => {
			query.removeEventListener('change', changed);
		};
	});
	/**
	 * How changed images are compared, the same on every image of the page, and
	 * kept while the page is open, through updates and regroups.
	 */
	let imageMode = $state<CompareMode>('side-by-side');
	function setImageMode(mode: CompareMode): void {
		imageMode = mode;
		if (viewer !== undefined) viewer.announcement = `Images compared: ${compareModeName(mode)}`;
	}

	const layout = $derived<Layout>(wide ? settings.layout : 'unified');
	$effect(() => {
		if (viewer !== undefined) viewer.layout = layout;
	});

	/**
	 * Changes how the diff is drawn without moving the reader: the part at the
	 * top of the screen (or the one they are on, when it is on the screen) stays
	 * where it was, however much taller or shorter its lines are drawn now.
	 */
	async function keepingPlace(change: () => void): Promise<void> {
		// A move under way is where the reader is going: keep that place.
		mover.settle();
		const atTop = window.scrollY === 0;
		const anchor = atTop ? undefined : viewportPart(viewer);
		const before = anchor?.getBoundingClientRect().top;
		change();
		await tick();
		if (atTop) {
			window.scrollTo(0, 0);
			return;
		}
		if (anchor === undefined || before === undefined || !anchor.isConnected) return;
		window.scrollBy(0, anchor.getBoundingClientRect().top - before);
	}

	/** Changes a setting on the page at once, and has diff delver remember it for every diff. */
	async function changeSetting(change: SettingChange, said: string): Promise<void> {
		await keepingPlace(() => {
			settings = withSetting(settings, change);
		});
		if (viewer !== undefined) {
			viewer.colouring = settings.colours;
			viewer.hideWhiteSpace = settings.hideWhiteSpace;
			viewer.showNotes = settings.agentNotes;
			viewer.announcement = said;
		}
		const saved = await pageClient().changeSetting(change);
		if (!saved.ok && viewer !== undefined) {
			viewer.announcement = `${said} It could not be remembered for next time: ${describeApiError(saved.error)}`;
		}
	}

	function setLayout(chosen: Layout): void {
		void changeSetting(
			{ name: 'layout', value: chosen },
			chosen === 'side-by-side'
				? wide
					? 'Changes are shown side by side: before on the left, after on the right.'
					: 'Changes will be shown side by side when the window is wider; it is too narrow now.'
				: 'Changes are shown in one column.'
		);
	}

	function setHideWhiteSpace(hide: boolean): void {
		void changeSetting(
			{ name: 'hide-white-space', value: hide },
			hide
				? 'Changes that only change white space are drawn as unchanged lines. They are still counted, and marking a file reviewed covers them.'
				: 'Changes that only change white space are shown.'
		);
	}

	function setShowNotes(shown: boolean): void {
		void changeSetting(
			{ name: 'agent-notes', value: shown },
			shown
				? 'Agent notes are shown at their lines.'
				: 'Agent notes are hidden. They are still counted above the diff; press a to show them again.'
		);
	}

	function setColours(colours: boolean): void {
		void changeSetting(
			{ name: 'colours', value: colours },
			colours ? 'Code is coloured by language.' : 'Code is shown plain.'
		);
	}
	let helpOpen = $state(false);
	/** Whether the section view shows any part, with the filter as it is. */
	const anyShown = $derived(viewer?.parts.some((p) => viewer.shows(p.index)) ?? false);

	/** Keeps the view and the filter in the address, so a reload or a shared link keeps them. */
	function remember(): void {
		const url = new URL(shownPage.url.href);
		if (byFile) url.searchParams.set('view', 'files');
		else url.searchParams.delete('view');
		if (onlyWaiting) url.searchParams.set('only', 'unreviewed');
		else url.searchParams.delete('only');
		history.replaceState(history.state, '', url);
	}

	async function showByFile(files: boolean): Promise<void> {
		byFile = files;
		if (files) fileListMade = true;
		remember();
		await tick();
		if (files) document.getElementById('by-file-heading')?.focus();
	}

	function setOnlyWaiting(only: boolean): void {
		onlyWaiting = only;
		if (viewer !== undefined) viewer.onlyWaiting = only;
		remember();
		if (viewer !== undefined) {
			const left = viewer.waiting.filter(Boolean).length;
			viewer.announcement = only
				? `Showing only what you have not reviewed: ${countOf(left, 'file part', 'file parts')}.`
				: 'Showing everything.';
		}
	}

	/** Moves to a part: shown, opened if asked, focused and at the top of the screen. */
	async function goToPart(
		at: PartIndex,
		open: boolean,
		{ stillGoing, scroll = true }: { stillGoing?: () => boolean; scroll?: boolean } = {}
	): Promise<void> {
		if (viewer === undefined) return;
		const state = viewer.parts[at];
		if (state === undefined) return;
		if (byFile) {
			byFile = false;
			remember();
		}
		if (!viewer.shows(at)) setOnlyWaiting(false);
		viewer.current = at;
		viewer.atSummary = undefined;
		viewer.drawUpTo(at);
		if (open) state.open = true;
		if (state.open && !viewer.isLarge(state)) void viewer.load(at);
		await tick();
		if (stillGoing?.() === false) return;
		const toggle = document.getElementById(`part-${String(at)}-toggle`);
		toggle?.focus({ preventScroll: true });
		const part = document.getElementById(`part-${String(at)}`);
		if (part !== null && scroll) scrollToTop(part);
	}

	/**
	 * Takes the reader to the agent's overview, or a group's summary, as the
	 * next thing to read (DESIGN 8.1): at the top of the screen with its
	 * group's heading, focused, and said. Moving on from it, with `n` or `r`,
	 * marks it read.
	 */
	async function goToSummary(
		place: WritingPlace,
		{ said, stillGoing }: { said?: string; stillGoing?: () => boolean } = {}
	): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		const group = place.kind === 'summary' ? shown.groups[place.group] : undefined;
		if (place.kind === 'summary' && group === undefined) return;
		if (byFile) {
			byFile = false;
			remember();
		}
		if (group !== undefined) shown.drawUpTo(group.first);
		shown.atSummary = place;
		await tick();
		if (stillGoing?.() === false || viewer !== shown) return;
		const where =
			group === undefined
				? 'The agent’s overview of the change. Press n to go on.'
				: `The agent’s summary of ${group.name}. Press n to go on to its files.`;
		shown.announcement = said === undefined ? where : `${said} ${where}`;
		if (group === undefined) {
			const overview = document.getElementById(AGENT_OVERVIEW);
			if (overview instanceof HTMLDetailsElement) overview.open = true;
			overview?.focus({ preventScroll: true });
			if (overview !== null) mover.reveal(overview);
			return;
		}
		const summary = document.getElementById(`${group.anchor}-summary`);
		summary?.focus({ preventScroll: true });
		const heading = document.getElementById(`${group.anchor}-heading`);
		if (heading !== null) scrollToTop(heading);
	}

	/**
	 * Gives an element the keyboard and, unless `show` is false, moves the page
	 * to it as focusing would, only when it is not wholly on the screen, and
	 * then to the middle, but eased.
	 */
	function focusAndShow(element: HTMLElement | null, show = true): void {
		if (element === null) return;
		element.focus({ preventScroll: true });
		if (!show) return;
		mover.move(() => {
			if (!element.isConnected) return undefined;
			const box = element.getBoundingClientRect();
			const { top, bottom: below } = scrollPadding();
			const bottom = window.innerHeight - below;
			if (box.top >= top && box.bottom <= bottom) return window.scrollY;
			const middle = window.scrollY + box.top + box.height / 2 - (top + (bottom - top) / 2);
			const end = document.documentElement.scrollHeight - window.innerHeight;
			return Math.max(0, Math.min(middle, end));
		});
	}

	/** What is kept at the top of the screen while the diff settles, if anything: stopped by the next. */
	let keptAtTop: { stopped: boolean } | undefined;

	/**
	 * Keeps what was scrolled to the top of the screen there while the diff
	 * settles. Moved to before the page has its parts' lines and images, as soon
	 * after it opens, it goes only as far as the page then goes, and the page
	 * grows as they come: where it came to rest depended on how soon they came.
	 * Scrolled to the top again whenever the diff's size changes, until a frame
	 * passes with no change, no open part near the screen still waiting for its
	 * lines and nothing in the diff busy, or the reader moves on: by their own
	 * input, which the page's own scrolling never makes, the page scrolls
	 * something else to the top, or a tick starts (`stopKeepingAtTop`). The bound
	 * only ends the keeping if a part's lines never come.
	 */
	async function keepAtTop(element: HTMLElement, move: Move): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		if (keptAtTop !== undefined) keptAtTop.stopped = true;
		const kept = { stopped: false };
		keptAtTop = kept;
		const diff = element.closest('.content') ?? document.body;
		const since = { resized: false, readerMoved: false };
		const keeping = (): boolean =>
			!kept.stopped && !since.readerMoved && viewer === shown && element.isConnected;
		const again = (): boolean => {
			// While the move eases, its frames follow the element themselves.
			if (move.running) return true;
			const before = window.scrollY;
			placeAtTop(element);
			return window.scrollY !== before;
		};
		const observer = new ResizeObserver(() => {
			since.resized = true;
			if (keeping()) again();
		});
		const stopListening = whenReaderMoves(window, () => {
			since.readerMoved = true;
		});
		observer.observe(diff);
		try {
			let settledFrames = 0;
			for (let frame = 0; frame < SETTLE_FRAMES_AT_MOST; frame += 1) {
				await nextFrame();
				if (!keeping()) return;
				const waiting = shown.parts.some(
					(p) =>
						p.open &&
						p.near &&
						!shown.isLarge(p) &&
						(p.lines.kind === 'waiting' || p.lines.kind === 'loading')
				);
				const busy = diff.querySelector('[aria-busy="true"]') !== null;
				const moved = again();
				settledFrames = since.resized || waiting || busy || moved ? 0 : settledFrames + 1;
				if (settledFrames === 2) return;
				since.resized = false;
			}
		} finally {
			kept.stopped = true;
			if (keptAtTop === kept) keptAtTop = undefined;
			observer.disconnect();
			stopListening();
		}
	}

	/**
	 * Stops keeping anything at the top of the screen. A tick moves the page
	 * itself, putting a part reviewed away and opening one unticked again, and
	 * where the reader stays is then the tick's to keep (`tickTarget`). `r`
	 * moves to its part first, which keeps it at the top; kept on, whether the
	 * part opened again was scrolled back to the top would depend on whether the
	 * tick's answer came before the diff had been still for two frames.
	 */
	function stopKeepingAtTop(): void {
		if (keptAtTop !== undefined) keptAtTop.stopped = true;
	}

	let bookmark = $state.raw<Bookmark>();
	let bookmarkMessage = $state('');
	let narrowBookmarks = $state<HTMLDivElement>();
	let bookmarkTarget = $state.raw<{ part: PartState; line: BookmarkLine }>();
	const bookmarkReport = $derived(viewer?.id);

	$effect(() => {
		const id = bookmarkReport;
		bookmark = id === undefined ? undefined : readBookmark(id);
		bookmarkMessage = '';
	});

	function markReadingPlace(): void {
		const shown = viewer;
		if (shown === undefined) return;
		const top = Math.max(
			0,
			document.querySelector('[role="search"]')?.getBoundingClientRect().bottom ?? 0
		);
		const toolbar = narrowBookmarks?.getClientRects()[0];
		const bottom = toolbar?.top ?? window.innerHeight;
		let element: HTMLElement | undefined;
		let line: BookmarkLine | null = null;
		for (const visible of document.querySelectorAll<HTMLElement>('article.part')) {
			const box = visible.getBoundingClientRect();
			if (box.bottom <= top || box.top >= bottom) continue;
			const headerBottom = visible.querySelector('header')?.getBoundingClientRect().bottom ?? top;
			const row = lineInView(visible, Math.max(top, box.top, headerBottom), bottom);
			element ??= visible;
			if (row === null) continue;
			line = row;
			element = visible;
			break;
		}
		const part = partAtElement(shown, element);
		if (part === undefined || element === undefined) {
			bookmarkMessage = 'Move to a file in By section to bookmark your place.';
			return;
		}
		const place: Bookmark = {
			path: part.part.path,
			group: part.part.group,
			step: part.part.step,
			version: shown.version,
			line,
			open: part.open
		};
		bookmark = place;
		saveBookmark(shown.id, place);
		const name = shownPath(place.path);
		bookmarkMessage =
			line === null ? `Bookmarked the start of ${name}. No code line was visible.` : '';
		if (line !== null) shown.announcement = `Bookmarked ${name}, line ${String(line.line)}.`;
	}

	async function returnToBookmark(): Promise<void> {
		const shown = viewer;
		const place = bookmark;
		if (shown === undefined) return;
		if (place === undefined) {
			bookmarkMessage = 'Use Bookmark this spot to save your place first.';
			return;
		}

		const at = shown.partOf(place.group, place.path, place.step);
		const same = at === undefined ? undefined : shown.parts[at];
		const files = shown.parts.filter((part) => part.part.path === place.path);
		const name = shownPath(place.path);
		const fallback =
			(same !== undefined && shown.shows(same.index) ? same : undefined) ??
			files.find((part) => shown.shows(part.index));
		if (fallback === undefined) {
			bookmarkMessage =
				files.length > 0
					? `The filters hide ${name}. Show everything to return to it.`
					: `${name} is no longer in this diff. Bookmark another spot to replace it.`;
			return;
		}

		viewportRestore?.stop();
		let measuring: PartState | undefined;
		const stop = (): void => {
			stopListening();
			if (viewportRestore?.stop === stop) {
				if (measuring !== undefined) measuring.measuring = false;
				bookmarkTarget = undefined;
				viewportRestore = undefined;
			}
		};
		const stopListening = whenReaderMoves(window, stop);
		viewportRestore = { viewer: shown, stop };
		const stillReturning = (): boolean => viewportRestore?.stop === stop && viewer === shown;
		try {
			const line = shown.version === place.version ? place.line : null;
			let destination: BookmarkDestination | undefined;
			if (line !== null) {
				const candidates =
					same === undefined ? files : [same, ...files.filter((part) => part !== same)];
				for (const part of candidates) {
					await shown.load(part.index);
					if (!stillReturning()) return;
					const found = bookmarkDestination(part, line);
					if (
						found !== undefined &&
						(destination === undefined || found.priority > destination.priority)
					) {
						destination = found;
					}
					if (destination?.priority === 3) break;
				}
			}
			const part = destination?.part ?? fallback;
			if (!shown.shows(part.index)) {
				bookmarkMessage = `The filters hide the bookmarked line in ${name}. Show everything to return to it.`;
				return;
			}

			// Returning is a new destination. Closing search here leaves its former place behind.
			shown.search.close();
			beforeSearch = undefined;
			searchOpenedFrom = null;
			bookmarkMessage = '';
			if (shown.version !== place.version) {
				bookmarkMessage = `This diff has a newer or different version. Showing the start of ${name}.`;
			} else if (line !== null && destination === undefined) {
				bookmarkMessage = `The bookmarked line is unavailable. Showing the start of ${name}.`;
			}
			if (destination !== undefined) {
				measuring = part;
				part.showLarge = true;
				part.measuring = true;
			}
			await goToPart(part.index, destination !== undefined || place.open);
			if (line === null || destination === undefined || !stillReturning()) return;

			const block = destination.block;
			if (block.kind === 'hidden')
				await shown.openBookmarkContext(part.index, destination.index, line);
			if (!stillReturning() || !shown.shows(part.index)) return;
			if (block.kind === 'elsewhere') block.shown = true;
			if (block.kind === 'hunk' && wholeHunkHidden(shown.drawnLines(block)) !== undefined) {
				block.showWhiteSpace = true;
			}
			bookmarkTarget = { part, line };
			await tick();
			await tick();
			if (!stillReturning() || !shown.shows(part.index)) return;
			const element = document.getElementById(`part-${String(part.index)}`);
			const row = element === null ? null : bookmarkedRow(element, line);
			if (row === null) {
				bookmarkMessage = `The bookmarked line is unavailable. Showing the start of ${name}.`;
				if (element !== null) scrollToTop(element);
				return;
			}
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
			scrollToTop(row);
			shown.announcement = `Returned to ${name}, line ${String(line.line)}.`;
		} finally {
			stop();
		}
	}

	/**
	 * Goes to the next part waiting, saying first what `said` says, if anything,
	 * unless `stillGoing` says otherwise once the page is drawn.
	 */
	async function nextUnread(said?: string, stillGoing?: () => boolean): Promise<void> {
		if (viewer === undefined) return;
		// Moving on from the agent's writing the page took the reader to reads it,
		// and the next thing is the next after it.
		const from = viewer.moveOnFromSummary();
		const next = viewer.nextUnreadPlace(from);
		if (next?.kind === 'overview' || next?.kind === 'summary') {
			await goToSummary(next, {
				...(said === undefined ? {} : { said }),
				...(stillGoing === undefined ? {} : { stillGoing })
			});
			return;
		}
		const at = next?.at;
		if (at === undefined) {
			const nothingLeft = 'Everything is reviewed: there is nothing left to read.';
			viewer.announcement = said === undefined ? nothingLeft : `${said} ${nothingLeft}`;
			await tick();
			if (stillGoing?.() === false) return;
			focusAndShow(document.getElementById(EVERYTHING_REVIEWED));
			return;
		}
		if (said !== undefined) viewer.announcement = said;
		await goToPart(at, true, stillGoing === undefined ? {} : { stillGoing });
	}

	/** The presses of `r`, each taken once the one before it has finished, since they were last dropped. */
	let marking: Promise<void> = Promise.resolve();
	/** How many times the presses waiting were dropped: a press made before then is not taken. */
	let marksDropped = 0;

	/**
	 * Drops every press of `r` still waiting, and stops the one under way going
	 * any further, when what they were pressed on is gone or no longer what the
	 * person expects: a tick refused, the diff drawn again in another sorting, a
	 * dialog opened over it, the person moving by their own input, or the page
	 * left. A press made after it waits for none of them, not even a tick whose
	 * answer never comes: that one may still finish, and goes no further.
	 */
	function dropMarks(): void {
		marksDropped += 1;
		marking = Promise.resolve();
	}

	$effect(() => {
		// Drawn again in another sorting, or the page left: what was pressed on is gone.
		const shown = viewer;
		return () => {
			if (shown !== undefined) dropMarks();
		};
	});

	/** Whether a key press is one of `r`'s, which is no moving away while `r` marks. */
	function marksByKey(input: Event): boolean {
		return input instanceof KeyboardEvent && shortcutOf(keyPress(input)) === 'mark-reviewed';
	}

	/**
	 * `r`: marks the part the person is on reviewed and goes on to the next part
	 * waiting, as `n` does, so pressing it again and again reviews the diff part
	 * by part. On a part already reviewed, or ignored, it only goes on. A tick
	 * refused stays where its refusal is said. Presses are taken one after
	 * another, each from where the one before it left the person. When they move
	 * by their own input meanwhile, the press under way goes no further and those
	 * still waiting are dropped, so only a press made after the move acts, where
	 * they went. A refusal, the diff drawn again, a dialog or leaving the page
	 * drops them too.
	 */
	function markReviewedByKey(): void {
		const pressedOn = viewer;
		const pressed = marksDropped;
		const going = (): boolean => pressed === marksDropped && !dialogOpen();
		const run = async (): Promise<void> => {
			if (viewer !== pressedOn) dropMarks();
			if (!going()) return;
			await markAndMoveOn(going);
		};
		// A press that fails in the page says so where the page speaks, and the
		// next press is taken as if it had not happened.
		marking = marking.then(run).catch((error: unknown) => {
			if (pressed === marksDropped) dropMarks();
			console.error(error);
			if (viewer !== undefined)
				viewer.announcement =
					'Something went wrong on this page, so the file may or may not be marked as reviewed: its tick box shows which. Press r to try again, or reload the page.';
		});
	}

	/** One press of `r`, going on only while `stillGoing` says it may. */
	async function markAndMoveOn(stillGoing: () => boolean): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		if (byFile) {
			shown.announcement =
				'In By file, mark a file reviewed with its tick box, or choose By section to use r.';
			return;
		}
		if (shown.atSummary !== undefined) {
			// The agent's writing has nothing to tick: r goes on from it, as n does.
			await nextUnread(undefined, stillGoing);
			return;
		}
		const at = currentPart();
		const state = at === undefined ? undefined : shown.parts[at];
		if (at === undefined || state === undefined) {
			shown.announcement = 'There is no file shown here to mark as reviewed.';
			return;
		}
		// Moving away by their own input, from now on, drops this press and those
		// waiting; pressing r again, or holding it down, is no moving away.
		const stop = whenReaderMoves(window, dropMarks, (input) => !marksByKey(input));
		try {
			await markPart(shown, at, state, stillGoing);
		} finally {
			stop();
		}
	}

	/** Marks the part `r` was pressed on, as `markAndMoveOn` says. */
	async function markPart(
		shown: Viewer,
		at: PartIndex,
		state: PartState,
		stillGoing: () => boolean
	): Promise<void> {
		// Said, so that nobody takes the move for a tick of the part moved to.
		const name = shownPath(state.part.path);
		if (state.part.group.kind === 'ignored') {
			await nextUnread(`${name} is ignored, so it needs no review.`, stillGoing);
			return;
		}
		if (done(state.part.tally)) {
			await nextUnread(`${name} is already reviewed.`, stillGoing);
			return;
		}
		const part = document.getElementById(`part-${at}`);
		const toggle = document.getElementById(`part-${at}-toggle`);
		if (
			part !== null &&
			toggle !== null &&
			onScreen(toggle) &&
			part.getBoundingClientRect().top < stickyTop
		) {
			// The sticky header is already in view while reading deep in the file.
			shown.current = at;
			toggle.focus({ preventScroll: true });
		} else {
			await goToPart(at, false, { stillGoing });
		}
		if (viewer !== shown || !stillGoing()) return;
		await tickTarget({ kind: 'part', at }, true, { moveOn: stillGoing });
	}

	/** The next or previous part shown, from where the person is, even a part the filter has just hidden. */
	async function step(forward: boolean): Promise<void> {
		if (viewer === undefined) return;
		const at = forward ? viewer.nextShown() : viewer.previousShown();
		if (at === undefined) {
			viewer.announcement = forward ? 'This is the last file.' : 'This is the first file.';
			return;
		}
		await goToPart(at, false);
	}

	/** The part the person is on, for a key: the one they moved to, or the first shown. */
	function currentPart(): PartIndex | undefined {
		if (viewer === undefined) return undefined;
		return viewer.current ?? nextShown(viewer.shown);
	}

	/** Whether nothing on the page has focus, as when what had it has gone. */
	function focusLost(): boolean {
		return document.activeElement === null || document.activeElement === document.body;
	}

	async function afterTick(
		target: TickTarget,
		outcome: Awaited<ReturnType<Viewer['tick']>>,
		readerMoved: boolean,
		moveOn: (() => boolean) | undefined
	): Promise<void> {
		if (viewer === undefined || leftPage()) return;
		if (outcome.kind !== 'marked') dropMarks();
		switch (outcome.kind) {
			case 'sorting-changed':
				staleTick = {
					id: viewer.id,
					version: viewer.version,
					message: outcome.message,
					part: target.kind === 'part' ? viewer.parts[target.at] : undefined,
					group: target.kind === 'group' ? target.group.key : undefined
				};
				await refreshReview(true);
				return;
			case 'refused':
				if (outcome.outOfDate) await checkForChanges();
				return;
			case 'marked': {
				const beforeRefresh = viewer;
				if (outcome.refresh) await refreshReview(true);
				await tick();
				if (viewer !== beforeRefresh || leftPage()) return;
				// `r` goes on to the next part waiting, unless the reader moved away
				// meanwhile, when the next press acts where they went.
				if (moveOn?.() === true) {
					// On the last part the tick's own words say everything is reviewed, so
					// they stay, and focus goes to the notice that says so.
					if (outcome.allDone) focusAndShow(document.getElementById(EVERYTHING_REVIEWED));
					// The tick's own words come first, then where it went.
					else await nextUnread(viewer.announcement || undefined, moveOn);
					return;
				}
				if (readerMoved && !focusLost()) return;
				if (outcome.allDone) {
					focusAndShow(document.getElementById(EVERYTHING_REVIEWED), !readerMoved);
					return;
				}
				// Finishing a group moves on to the next one that still waits.
				const finished = outcome.groupFinished;
				if (finished !== undefined && !readerMoved) {
					const next = viewer.groups.find(
						(g) =>
							g.first > finished.first && g.key.kind !== 'ignored' && !done(viewer.groupTally(g))
					);
					if (next !== undefined && viewer.summaryUnread(next)) {
						// Its summary is the next thing to read, before its files.
						await goToSummary(
							{ kind: 'summary', group: viewer.groups.indexOf(next) },
							{ said: viewer.announcement }
						);
						return;
					}
					if (next !== undefined) focusAndShow(document.getElementById(`${next.anchor}-heading`));
				}
				if (byFile || !focusLost()) return;
				// What had focus went from the page with "Only what I have not reviewed": on
				// to the part shown after where it was, or before it when it was the last.
				const place = target.kind === 'part' ? target.at : viewer.current;
				const shown = viewer.shown;
				const reading = readerMoved ? partAtElement(viewer, viewportPart(undefined)) : undefined;
				const next = reading?.index ?? nextShown(shown, place) ?? previousShown(shown, place);
				if (next !== undefined) await goToPart(next, false, { scroll: !readerMoved });
				else focusAndShow(document.getElementById(EVERYTHING_REVIEWED), !readerMoved);
			}
		}
	}

	const closingParts = new SvelteSet<PartState>();

	async function tickTarget(
		target: TickTarget,
		reviewed: boolean,
		{ moveOn }: { moveOn?: () => boolean } = {}
	): Promise<void> {
		const shown = viewer;
		if (shown === undefined || shown.asOf !== undefined) return;
		staleTick = undefined;
		stopKeepingAtTop();
		// A move under way to the part ticked arrives first, so what the tick
		// keeps in place is measured where the reader is going.
		mover.settle();
		const animations: { part: PartState; animation: Animation }[] = [];
		let inputAt: number | undefined;
		let scrolled = false;
		// Pressing r again while it marks is no moving away, as for `r` itself.
		const stop = whenReaderMoves(
			window,
			() => {
				inputAt = window.scrollY;
			},
			(input) => !marksByKey(input)
		);
		const recordScroll = (): void => {
			if (inputAt !== undefined && window.scrollY !== inputAt) scrolled = true;
		};
		window.addEventListener('scroll', recordScroll);
		let kept: ReturnType<typeof readerPlace> | undefined;
		const keepPlace = (): void => {
			recordScroll();
			if (!scrolled || byFile || !onlyWaiting || viewer !== shown) return;
			// Anchor surviving code before the filter removes the reviewed parts.
			kept = readerPlace((element) => {
				const state = partAtElement(shown, element);
				if (state === undefined || !shown.shows(state.index) || !onScreen(element)) return false;
				switch (target.kind) {
					case 'part':
						return state.index !== target.at;
					case 'file':
						return state.part.path !== target.path;
					case 'group':
						return (
							state.index < target.group.first ||
							state.index >= target.group.first + target.group.count
						);
				}
			});
		};
		const animatePart = (part: PartState): void => {
			if (kept === undefined) keepPlace();
			if (
				viewer !== shown ||
				inputAt !== undefined ||
				byFile ||
				!part.near ||
				closingParts.has(part)
			)
				return;
			const animation = collapseReviewedPart(part.index, onlyWaiting, stickyTop);
			if (animation === undefined) return;
			closingParts.add(part);
			animations.push({ part, animation });
		};
		try {
			const outcome = await shown.tick(target, reviewed, reviewed ? animatePart : undefined);
			if (animations.length > 0) {
				await Promise.allSettled(animations.map(({ animation }) => animation.finished));
				keepPlace();
				for (const { part } of animations) closingParts.delete(part);
				await tick();
				for (const { animation } of animations) animation.cancel();
			}
			await tick();
			if (viewer === shown) {
				if (kept !== undefined) {
					const anchor = document.getElementById(kept.anchor);
					if (anchor === null) window.scrollTo(0, kept.y);
					else window.scrollBy(0, anchor.getBoundingClientRect().top - kept.top);
				}
				await afterTick(target, outcome, inputAt !== undefined, moveOn);
			}
		} finally {
			stop();
			window.removeEventListener('scroll', recordScroll);
		}
	}

	async function tickPart(at: PartIndex, reviewed: boolean): Promise<void> {
		await tickTarget({ kind: 'part', at }, reviewed);
	}

	async function tickGroup(group: GroupInfo, reviewed: boolean): Promise<void> {
		await tickTarget({ kind: 'group', group }, reviewed);
	}

	async function tickFile(file: FileView, reviewed: boolean): Promise<void> {
		await tickTarget({ kind: 'file', path: file.path }, reviewed);
	}

	function goToSectionFile(at: PartIndex): void {
		void goToPart(at, true);
	}

	async function goTo(
		path: EscapedPath,
		group: GroupKeyView,
		step?: OrderStep | null
	): Promise<void> {
		const at = viewer?.partOf(group, path, step);
		if (at !== undefined) await goToPart(at, true);
	}

	// ── Searching the diff ──────────────────────────────────────────────────────

	const SEARCH_INPUT = 'search-input';
	let searchHeight = $state(0);
	const stickyTop = $derived(viewer?.search.open ? searchHeight : 0);
	/** What had focus when the search was opened, to go back to when it closes. */
	let searchOpenedFrom: HTMLElement | null = null;
	/** Where the reader was before the search first moved them, to put them back. */
	let beforeSearch:
		| {
				readonly anchor: string;
				readonly top: number;
				readonly y: number;
				readonly byFile: boolean;
		  }
		| undefined;
	/** Moving to a match is under way: the search says it is busy. */
	let movingToMatch = $state(false);

	// A newer version keeps the search open, with what is in the box, searched
	// again; where it moved the reader was in the older one, so is forgotten.
	$effect(() => {
		const shown = viewer;
		if (shown === undefined) return;
		untrack(() => {
			beforeSearch = undefined;
			// What had focus when it opened was drawn for the older version, and is gone.
			if (searchOpenedFrom?.isConnected !== true) searchOpenedFrom = null;
			if (shown.search.open && shown.search.text !== '') void shown.search.search();
		});
	});

	function nextFrame(): Promise<void> {
		return new Promise((resolve) => {
			requestAnimationFrame(() => {
				resolve();
			});
		});
	}

	/**
	 * Takes the reader to a group's heading, at the top of the screen. Focusing it
	 * alone would scroll only until it showed, at the bottom of the screen, where
	 * the parts above it, still filling in their lines, would push it off again.
	 */
	function goToGroupHeading(anchor: string): void {
		const heading = document.getElementById(`${anchor}-heading`);
		if (heading === null) return;
		scrollToTop(heading);
		heading.focus({ preventScroll: true });
		// Its summary is where they are, so moving on from it reads it.
		const group = viewer?.groups.findIndex((g) => g.anchor === anchor) ?? -1;
		if (viewer !== undefined && group >= 0 && viewer.groups[group]?.summary !== null) {
			viewer.atSummary = { kind: 'summary', group };
		}
	}

	/**
	 * Scrolls an element to the top of the screen, as far as the page goes, and
	 * below the search when it is open, and keeps it there while the diff
	 * settles (`keepAtTop`).
	 */
	function scrollToTop(element: HTMLElement): void {
		const move = mover.move(() => (element.isConnected ? topOf(element) : undefined));
		void keepAtTop(element, move);
	}

	/**
	 * Scrolls an element to the top of the screen, as far as the page goes, and
	 * below the search when it is open: the search stays at the top of the
	 * screen, so whatever its height it would otherwise be drawn over the element.
	 */
	function placeAtTop(element: HTMLElement): void {
		window.scrollTo(0, topOf(element));
	}

	/**
	 * Where the window's scroll puts an element at the top of the screen, as
	 * `placeAtTop` does: below its margin, the search when it is open, and its
	 * part's sticky header when it is inside a part; as far as the page goes.
	 */
	function topOf(element: HTMLElement): number {
		const part = element.closest('article.part');
		const header = part === element ? null : part?.querySelector('header');
		const clearance = header?.getBoundingClientRect().height ?? 0;
		const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
		const top =
			window.scrollY +
			element.getBoundingClientRect().top -
			margin -
			scrollPadding().top -
			stickyTop -
			clearance;
		const bottom = document.documentElement.scrollHeight - window.innerHeight;
		return Math.max(0, Math.min(top, bottom));
	}

	/**
	 * The page's scroll padding, which a scroll to an element keeps clear: at
	 * the bottom, the overall review's bar and the bookmarks pinned there.
	 */
	function scrollPadding(): { top: number; bottom: number } {
		const style = getComputedStyle(document.documentElement);
		return {
			top: parseFloat(style.scrollPaddingTop) || 0,
			bottom: parseFloat(style.scrollPaddingBottom) || 0
		};
	}

	/** Where the reader is: the part at the top of the screen and how far down it is. */
	function readerPlace(accepts: (element: HTMLElement) => boolean = () => true): {
		readonly anchor: string;
		readonly top: number;
		readonly y: number;
	} {
		const parts = [...document.querySelectorAll<HTMLElement>('article.part')];
		const anchor = parts.find((p) => p.getBoundingClientRect().bottom > 0 && accepts(p));
		return {
			anchor: anchor?.id ?? '',
			top: anchor?.getBoundingClientRect().top ?? 0,
			y: window.scrollY
		};
	}

	async function openSearch(): Promise<void> {
		if (viewer === undefined) return;
		const active = document.activeElement;
		// Where focus goes back to when the search closes: what had it when the search
		// opened, or, when that went with an older version, what has it now.
		if (!viewer.search.open || (searchOpenedFrom === null && active?.id !== SEARCH_INPUT)) {
			searchOpenedFrom = active instanceof HTMLElement && active !== document.body ? active : null;
			viewer.search.open = true;
		}
		await tick();
		const input = document.getElementById(SEARCH_INPUT);
		if (input instanceof HTMLInputElement) {
			input.focus();
			input.select();
		}
	}

	/** Puts the reader back where they were before the search moved them, in the view they were in. */
	async function putReaderBack(): Promise<void> {
		const place = beforeSearch;
		beforeSearch = undefined;
		if (place === undefined) return;
		if (place.byFile !== byFile) {
			byFile = place.byFile;
			remember();
		}
		await tick();
		const anchor = place.anchor === '' ? null : document.getElementById(place.anchor);
		mover.move(() =>
			anchor?.isConnected === true
				? window.scrollY + anchor.getBoundingClientRect().top - place.top
				: place.y
		);
	}

	async function closeSearch(): Promise<void> {
		if (viewer === undefined) return;
		viewer.search.close();
		await putReaderBack();
		const back = searchOpenedFrom;
		searchOpenedFrom = null;
		(back?.isConnected === true ? back : document.getElementById(PAGE_HEADING))?.focus({
			preventScroll: true
		});
	}

	async function searchTyped(text: string): Promise<void> {
		if (viewer === undefined) return;
		if (text !== '') {
			viewer.search.typed(text);
			return;
		}
		viewer.search.text = '';
		await viewer.search.search();
		await putReaderBack();
	}

	/** How long, at most, a match moved to is kept in the middle while what is above it settles. */
	const SETTLE_FRAMES_AT_MOST = 300;

	/**
	 * Scrolls the current match to the middle of the screen once it is drawn,
	 * and keeps it there while what is above it settles: parts coming near the
	 * screen are laid out and their lines come, which moves everything below.
	 * Nothing, once a newer version's viewer has replaced the one moved in.
	 */
	async function showMatch(shown: Viewer, match: CurrentMatch): Promise<void> {
		if (viewer !== shown) return;
		// The search has the part's lines already: one turn draws them, and another
		// the chunk of a long hunk that holds the match.
		await tick();
		await tick();
		if (viewer !== shown || !shown.search.open) return;
		const element =
			match.place.kind === 'path'
				? document.getElementById(`part-${String(match.at)}-name`)
				: document.querySelector<HTMLElement>(`#part-${String(match.at)} [data-current-match]`);
		if (element === null) {
			// Never silently: the search box says so, the part at least is shown, and
			// the error is seen.
			console.error(`The match moved to in part ${String(match.at)} was not drawn.`);
			shown.search.notShown(match);
			const part = document.getElementById(`part-${String(match.at)}`);
			if (part !== null) mover.move(() => (part.isConnected ? topOf(part) : undefined));
			return;
		}
		const part = element.closest('article.part');
		const header = part?.querySelector('header');
		const searchBar = document.querySelector('[role="search"]');
		/** Where the window's scroll puts the match in the middle, or nowhere new. */
		const middleOf = (): number | undefined => {
			if (!element.isConnected) return undefined;
			const box = element.getBoundingClientRect();
			const head = header?.getBoundingClientRect();
			const pathMatch = match.place.kind === 'path';
			const searchHeight = searchBar?.getBoundingClientRect().height ?? 0;
			const top = searchHeight + (pathMatch ? 0 : (head?.height ?? 0));
			const bottom = narrowBookmarks?.getClientRects()[0]?.top ?? window.innerHeight;
			const middle = Math.max(top + box.height / 2, (top + bottom) / 2);
			// A sticky path's place in the document is the start of its article.
			const matchTop =
				pathMatch && head !== undefined && part !== null
					? part.getBoundingClientRect().top + box.top - head.top
					: box.top;
			const distance = matchTop + box.height / 2 - middle;
			return Math.abs(distance) >= 1 ? window.scrollY + distance : window.scrollY;
		};
		const move = mover.move(middleOf);
		const centre = (): boolean => {
			// While the move eases, its frames follow the match themselves.
			if (move.running) return true;
			const before = window.scrollY;
			const to = middleOf();
			if (to !== undefined && to !== before) window.scrollTo(0, to);
			return window.scrollY !== before;
		};
		// Centred again whenever the diff's size changes, until a frame passes with
		// no change and no part above still fetching its lines, or the reader moves
		// on: by their own input (a wheel, a touch, a key, the scroll bar), which
		// the page's own scrolling never makes, or to another part, as with j or k.
		// The bound only ends the keeping of a match already centred, if a part's
		// lines never come.
		const diff = element.closest('.content') ?? document.body;
		const since = { resized: false, readerMoved: false };
		const keeping = (): boolean =>
			!since.readerMoved &&
			movesAsked <= 1 &&
			viewer === shown &&
			shown.search.open &&
			shown.current === match.at;
		const observer = new ResizeObserver(() => {
			since.resized = true;
			if (element.isConnected && keeping()) centre();
		});
		const stopListening = whenReaderMoves(window, () => {
			since.readerMoved = true;
		});
		observer.observe(diff);
		if (header != null) observer.observe(header);
		if (searchBar !== null) observer.observe(searchBar);
		if (narrowBookmarks !== undefined) observer.observe(narrowBookmarks);
		try {
			let settledFrames = 0;
			for (let frame = 0; frame < SETTLE_FRAMES_AT_MOST; frame += 1) {
				await nextFrame();
				if (!keeping() || !element.isConnected) return;
				const fetching = shown.parts.some((p) => p.index < match.at && p.lines.kind === 'loading');
				const moved = centre();
				settledFrames = since.resized || fetching || moved ? 0 : settledFrames + 1;
				if (settledFrames === 2) return;
				since.resized = false;
			}
		} finally {
			observer.disconnect();
			stopListening();
		}
	}

	/** Moves under way and asked for, one after another, so a quick Enter is never lost. */
	let searchMoves: Promise<void> = Promise.resolve();
	let movesAsked = 0;

	function stepSearch(forward: boolean): Promise<void> {
		movesAsked += 1;
		movingToMatch = true;
		searchMoves = searchMoves.then(async () => {
			try {
				await moveToMatch(forward);
			} finally {
				movesAsked -= 1;
				if (movesAsked === 0) movingToMatch = false;
			}
		});
		return searchMoves;
	}

	/** Moves to the next match, or the previous; nothing once a newer version replaces the viewer. */
	async function moveToMatch(forward: boolean): Promise<void> {
		if (viewer === undefined) return;
		const shown = viewer;
		const search = shown.search;
		// Enter pressed before the search that typing started: search now.
		const found = search.found;
		if (search.text !== '' && (found.kind !== 'found' || found.text !== search.text)) {
			await search.search();
		}
		if (viewer !== shown || search.found.kind !== 'found') return;
		if (search.totals.matches === 0) {
			shown.announcement = 'No matches.';
			return;
		}
		beforeSearch ??= { ...readerPlace(), byFile };
		const moved = await search.step(forward);
		// The part numbers of an older version are not this one's: show nothing.
		if (moved === undefined || viewer !== shown || !search.open) return;
		if (byFile) {
			byFile = false;
			remember();
		}
		await showMatch(shown, moved);
	}

	function setSearchOption(
		option: 'match-case' | 'changed-only' | 'skip-closed',
		on: boolean
	): void {
		if (viewer === undefined) return;
		const search = viewer.search;
		const change: SettingChange =
			option === 'match-case'
				? { name: 'search-match-case', value: on }
				: option === 'changed-only'
					? { name: 'search-changed-only', value: on }
					: { name: 'search-skip-closed', value: on };
		settings = withSetting(settings, change);
		search.matchCase = settings.searchMatchCase;
		search.changedOnly = settings.searchChangedOnly;
		search.skipClosed = settings.searchSkipClosed;
		if (search.text !== '') void search.search();
		void pageClient()
			.changeSetting(change)
			.then((saved) => {
				if (!saved.ok) {
					viewer.announcement = `The option could not be remembered for next time: ${describeApiError(saved.error)}`;
				}
			});
	}

	let fileOpener = $state(false);
	/** The panel that opens another Delve, which the layout draws. */
	const switcher = delveSwitcher();
	let fileMenuButton: HTMLButtonElement | undefined = $state();
	let fileFocus: HTMLElement | undefined;
	const readerUrl = $derived(shownPage.shallow?.url ?? shownPage.url);
	const readerPath = $derived(parseEscapedPath(readerUrl.searchParams.get('file') ?? ''));
	const readerSide = $derived(parseSide(readerUrl.searchParams.get('side') ?? 'new'));
	const readerVersion = $derived(
		parseRevisionNumber(Number(readerUrl.searchParams.get('version') ?? viewer?.version))
	);
	const fileReaderOpen = $derived(readerPath.ok && readerSide.ok && readerVersion.ok);

	/**
	 * Whether a dialog is open over the diff: the shortcuts, the file opener or
	 * reader, the switcher, or one that asks first, such as before deleting a comment.
	 */
	function dialogOpen(): boolean {
		return (
			helpOpen ||
			fileOpener ||
			fileReaderOpen ||
			switcher.open ||
			document.querySelector('dialog[open]') !== null
		);
	}

	/** Whether the person has left this page, so an answer that comes later moves nothing. */
	let left = false;
	onDestroy(() => {
		left = true;
	});
	/** Asked anew after each wait, since the page may have been left meanwhile. */
	function leftPage(): boolean {
		return left;
	}

	$effect(() => {
		if (dialogOpen()) dropMarks();
	});
	interface FileJump {
		readonly id: ReportId;
		readonly version: RevisionNumber;
		readonly path: EscapedPath;
		readonly side: Side;
		readonly line: LineNumber | undefined;
	}
	let fileJump: FileJump | undefined;
	let hadFileReader = false;

	function openFileMenu(): void {
		fileJump = undefined;
		fileFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		fileOpener = true;
	}

	function focusAfterFile(): void {
		const from = fileFocus;
		fileFocus = undefined;
		(from?.isConnected === true ? from : fileMenuButton)?.focus({ preventScroll: true });
	}

	async function cancelFileMenu(): Promise<void> {
		fileOpener = false;
		await tick();
		focusAfterFile();
	}

	function fileQuery(path: EscapedPath, side: Side, version: RevisionNumber): URLSearchParams {
		const query = new URL(readerUrl.href).searchParams;
		query.set('file', path);
		query.set('side', side);
		query.set('version', String(version));
		return query;
	}

	async function pickFile(file: FileMatch): Promise<void> {
		if (viewer === undefined) return;
		fileOpener = false;
		const query = fileQuery(file.path, file.side, viewer.version);
		await goto(resolve(`/diffs/[id]?${query}`, { id: data.id }), {
			shallow: true,
			state: { fileOpenedFromDelve: true },
			persistState: true
		});
	}

	async function switchFile(path: EscapedPath, side: Side): Promise<void> {
		if (!readerVersion.ok) return;
		const query = fileQuery(path, side, readerVersion.value);
		await goto(resolve(`/diffs/[id]?${query}`, { id: data.id }), {
			shallow: true,
			replace: true,
			state: shownPage.state,
			persistState: true
		});
	}

	function addressWithoutFile(): URLSearchParams {
		const query = new URL(readerUrl.href).searchParams;
		query.delete('file');
		query.delete('side');
		return query;
	}

	async function closeFile(): Promise<void> {
		if (shownPage.state.fileOpenedFromDelve === true) {
			history.back();
		} else {
			const query = addressWithoutFile();
			await goto(
				resolve(query.size === 0 ? '/diffs/[id]' : `/diffs/[id]?${query}`, { id: data.id }),
				{
					shallow: true,
					replace: true
				}
			);
		}
	}

	async function jumpFromFile(path: EscapedPath, side: Side, line?: LineNumber): Promise<void> {
		if (!readerVersion.ok || viewer === undefined || fileJump !== undefined) return;
		const version = readerVersion.value;
		fileJump = { id: viewer.id, version, path, side, line };
		if (
			version === viewer.version &&
			data.requestedVersion === null &&
			!shownPage.url.searchParams.has('file')
		) {
			await closeFile();
			return;
		}

		// Forward can restore the pinned page that opened the reader, even
		// after the preceding history entry was replaced with the latest Delve.
		// Navigate to the pinned diff so it still shows this version on reload.
		const query = addressWithoutFile();
		query.set('version', String(version));
		await goto(resolve(`/diffs/[id]?${query}`, { id: viewer.id }), { reset: false });
	}

	$effect(() => {
		const open = fileReaderOpen;
		if (open && !hadFileReader) fileJump = undefined;
		if (!open && hadFileReader) {
			const jump = fileJump;
			void tick().then(async () => {
				const address = new URL(window.location.href);
				const stillHere = (): boolean => !fileOpener && window.location.href === address.href;
				if (address.searchParams.has('file') || !stillHere()) return;
				if (jump === undefined) {
					// A shallow Back can reuse data from the reader's original page
					// even when that earlier history entry now asks for another version.
					if (data.requestedVersion !== address.searchParams.get('version')) {
						await invalidate('app:diff', true);
						if (!stillHere()) return;
					}
					focusAfterFile();
				} else if (fileJump === jump) {
					try {
						await showFileChange(jump);
					} finally {
						if (fileJump === jump) fileJump = undefined;
					}
				}
			});
		}
		hadFileReader = open;
	});

	async function showFileChange(jump: FileJump): Promise<void> {
		const shown = viewer;
		if (shown?.id !== jump.id || shown.version !== jump.version) return;
		const stillGoing = (): boolean =>
			fileJump === jump &&
			viewer === shown &&
			!fileReaderOpen &&
			!new URLSearchParams(window.location.search).has('file');
		if (!stillGoing()) return;
		const parts = shown.parts.filter(({ part }) => part.path === jump.path);
		const fallback = parts[0];
		if (fallback === undefined) {
			focusAfterFile();
			return;
		}
		if (jump.line === undefined) {
			await goToPart(fallback.index, true, { stillGoing });
			return;
		}

		const line: BookmarkLine = { side: jump.side, line: jump.line };
		for (const part of parts) {
			await shown.load(part.index);
			if (!stillGoing()) return;
			const destination = bookmarkDestination(part, line);
			if (destination?.priority !== 3 || destination.block.kind !== 'hunk') continue;
			const block = destination.block;
			viewportRestore?.stop();
			part.showLarge = true;
			part.measuring = true;
			if (settings.hideWhiteSpace) block.showWhiteSpace = true;
			const target = { part, line };
			try {
				await goToPart(part.index, true, { stillGoing });
				if (!stillGoing()) return;
				bookmarkTarget = target;
				await tick();
				await tick();
				if (!stillGoing()) return;
				const element = document.getElementById(`part-${part.index}`);
				const row = element === null ? null : bookmarkedRow(element, line);
				if (row !== null) {
					row.tabIndex = -1;
					row.focus({ preventScroll: true });
					scrollToTop(row);
				}
			} finally {
				if (bookmarkTarget === target) bookmarkTarget = undefined;
				part.measuring = false;
			}
			return;
		}
		await goToPart(fallback.index, true, { stillGoing });
	}

	/** A key press as the shortcuts read it. */
	function keyPress(event: KeyboardEvent): KeyPress {
		const target = event.target instanceof HTMLElement ? event.target : null;
		return {
			key: event.key,
			ctrlKey: event.ctrlKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			target:
				target === null
					? null
					: {
							tagName: target.tagName,
							...(target instanceof HTMLInputElement ? { type: target.type } : {}),
							isContentEditable: target.isContentEditable
						}
		};
	}

	/** The keys that change the Delve, which do nothing as of a finished review. */
	const CHANGES: ReadonlySet<string> = new Set([
		'mark-reviewed',
		'comment',
		'flag',
		'ask',
		'overall-review'
	]);

	function onKey(event: KeyboardEvent): void {
		if (viewer === undefined || dialogOpen()) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (isFindKey(event, target?.id === SEARCH_INPUT)) {
			event.preventDefault();
			void openSearch();
			return;
		}
		const action = shortcutOf(keyPress(event));
		if (action === undefined) return;
		event.preventDefault();
		if (event.repeat && !actsOnRepeat(action)) return;
		const at = action === 'toggle-open' || action === 'whole-file' ? currentPart() : undefined;
		const state = at === undefined ? undefined : viewer.parts[at];
		if (viewer.asOf !== undefined && CHANGES.has(action)) {
			viewer.announcement = `This is the Delve as of review ${String(viewer.asOf)}, which cannot be changed. Go back to the current version to change it.`;
			return;
		}
		switch (action) {
			case 'next-unread':
				void nextUnread();
				return;
			case 'next-part':
				void step(true);
				return;
			case 'previous-part':
				void step(false);
				return;
			case 'mark-reviewed':
				markReviewedByKey();
				return;
			case 'toggle-open':
				if (byFile || at === undefined || state === undefined) return;
				state.open = !state.open;
				void goToPart(at, false);
				return;
			case 'comment':
				void commentKey('comment');
				return;
			case 'flag':
				void commentKey('flag');
				return;
			case 'ask':
				void commentKey('ask');
				return;
			case 'next-flag':
				void nextFlag();
				return;
			case 'next-thread':
				void nextThread();
				return;
			case 'whole-file':
				if (byFile || at === undefined) return;
				void goToPart(at, true).then(() => viewer.wholeFile(at));
				return;
			case 'only-unreviewed':
				setOnlyWaiting(!onlyWaiting);
				return;
			case 'white-space':
				setHideWhiteSpace(!settings.hideWhiteSpace);
				return;
			case 'agent-notes':
				if (viewer.notes.length === 0) {
					viewer.announcement = 'The agent left no notes on this version.';
					return;
				}
				{
					// A note's button with the keyboard is about to go: the toggle takes it.
					const inNote = document.activeElement?.closest('[data-agent-note]') ?? null;
					setShowNotes(!settings.agentNotes);
					if (inNote !== null)
						void tick().then(() => document.getElementById('agent-notes-toggle')?.focus());
				}
				return;
			case 'side-by-side':
				setLayout(settings.layout === 'side-by-side' ? 'unified' : 'side-by-side');
				return;
			case 'compare-images':
				if (!viewer.hasImagesToCompare()) {
					viewer.announcement = 'There are no changed images here to compare.';
					return;
				}
				setImageMode(nextCompareMode(imageMode));
				return;
			case 'bookmark':
				markReadingPlace();
				return;
			case 'return-to-bookmark':
				void returnToBookmark();
				return;
			case 'search':
				void openSearch();
				return;
			case 'open-file':
				openFileMenu();
				return;
			case 'other-delves':
				switcher.open = true;
				return;
			case 'overall-review':
				overallKey();
				return;
			case 'help':
				helpOpen = true;
				return;
		}
	}

	/** How tall the overall review's bar and, on a narrow screen, the bookmarks under it are. */
	let overallHeight = $state(0);
	let dockHeight = $state(0);

	// What takes the keyboard is scrolled clear of the bar and the bookmarks at the foot.
	// 16 pixels: the gap the bar keeps under it, and a little room above it.
	$effect(() => {
		const root = document.documentElement;
		root.style.scrollPaddingBottom = `${String(overallHeight + dockHeight + 16)}px`;
		return () => {
			root.style.scrollPaddingBottom = '';
		};
	});

	/** Opens or puts away the overall review's bar, and has diff delver remember it for every Delve. */
	function setOverallOpen(open: boolean): void {
		const change: SettingChange = { name: 'overall-review-open', value: open };
		settings = withSetting(settings, change);
		void pageClient()
			.changeSetting(change)
			.then((saved) => {
				if (!saved.ok && viewer !== undefined) {
					viewer.announcement = `Whether the overall review is open could not be remembered for next time: ${describeApiError(saved.error)}`;
				}
			});
	}

	/**
	 * `v`: to the overall review's box, opening the bar if it is put away; from
	 * the bar itself, it puts the bar away.
	 */
	function overallKey(): void {
		if (viewer === undefined) return;
		const comments = commentsFor(viewer.id);
		const bar = document.querySelector('[data-overall-review]');
		const inBar =
			bar !== null && document.activeElement !== null && bar.contains(document.activeElement);
		if (settings.overallReviewOpen && inBar) {
			setOverallOpen(false);
			void tick().then(() => bar.querySelector<HTMLElement>('[aria-expanded]')?.focus());
			return;
		}
		if (!settings.overallReviewOpen) setOverallOpen(true);
		comments.overallWriting.focusAsked += 1;
	}

	/** From the overall review's bar to Finish and copy, which takes the keyboard. */
	async function goToFinish(): Promise<void> {
		await tick();
		const target =
			document.getElementById('finish-and-copy') ?? document.getElementById('finish-review');
		if (target === null) return;
		target.focus({ preventScroll: true });
		mover.move(() => {
			if (!target.isConnected) return undefined;
			const box = target.getBoundingClientRect();
			// The middle of the screen clear of what is pinned to its edges.
			const { top, bottom: below } = scrollPadding();
			const middle =
				window.scrollY + box.top + box.height / 2 - (top + (window.innerHeight - top - below) / 2);
			const bottom = document.documentElement.scrollHeight - window.innerHeight;
			return Math.max(0, Math.min(middle, bottom));
		});
	}

	/** Which part has focus, so keys act on the part the person is in. */
	function onFocusIn(event: FocusEvent): void {
		if (viewer === undefined || !(event.target instanceof Element)) return;
		const target = event.target;
		const part = partAtElement(viewer, target);
		if (part === undefined) return;
		viewer.current = part.index;
		viewer.atSummary = undefined;
		if (target.closest('.body') === null) return;
		const header = target.closest('article.part')?.querySelector('header');
		const pinned = header?.getBoundingClientRect();
		if (pinned === undefined || pinned.top > stickyTop + 1) return;
		const focused = target.getBoundingClientRect();
		if (focused.bottom > pinned.top && focused.top < pinned.bottom) {
			window.scrollBy(0, focused.top - pinned.bottom - 4);
		}
	}

	/** How far a group has got, after its name: "all reviewed", "2 of 5 changes reviewed". */
	function groupProgress(tally: TallyView): string {
		return done(tally) ? 'all reviewed' : describeTally(tally);
	}

	function progressText(reviewed: number, units: number): string {
		if (units === 0) return 'Nothing to review: every change is ignored';
		if (reviewed === 0) return `Not started: ${describeChanges(units)} to review`;
		if (reviewed === units) return `Everything reviewed: ${describeChanges(units)}`;
		return `${formatCount(reviewed)} of ${describeChanges(units)} reviewed`;
	}
	let draftsControl = $state<HTMLButtonElement>();

	// A browser let in by a link is let write comments while the page is open
	// (`ReviewAccess.svelte`): say so, and keep focus on the page, since the
	// notice that had it has gone.
	let couldReview = untrack(() => data.canReview);
	let reviewTurnedOn = $state(false);
	$effect(() => {
		const can = data.canReview;
		if (can && !couldReview) {
			reviewTurnedOn = true;
			void tick().then(() => {
				if (focusLost()) draftsControl?.focus();
			});
		}
		couldReview = can;
	});
	/**
	 * A Delve's comments, kept by the tab and not by this page or a viewer
	 * (`kept-comments.ts`): what is being written outlives an update, a regroup,
	 * a look at another Delve, and leaving this page by one of its links.
	 */
	function commentsFor(id: ReportId): Comments {
		return untrack(() => keptComments(id, pageClient));
	}

	/**
	 * Comments that are never read: the Delve as of a finished review draws
	 * none of the draft, which is today's and not that review's.
	 */
	let noneKept: Comments | undefined;
	function noComments(id: ReportId): Comments {
		if (noneKept?.id !== id) noneKept = untrack(() => new Comments(id, pageClient()));
		return noneKept;
	}

	// The saved draft is read once this browser may read it, and again whenever
	// the person comes back to the page, since another tab may have written.
	$effect(() => {
		if (!data.canReview || !data.loaded.ok) return;
		const comments = commentsFor(data.id);
		const read = (): void => {
			if (document.visibilityState === 'visible') void comments.load();
		};
		read();
		window.addEventListener('focus', read);
		return () => {
			window.removeEventListener('focus', read);
		};
	});

	/** The thread of an earlier review last gone to with `p`, by id. */
	let lastThread: number | undefined;

	/**
	 * Goes to a thread of an earlier review: among the lines of the version
	 * shown when it is drawn there, else to where the list above the diff
	 * draws it in full, as for one whose file is not in this version's diff.
	 */
	async function goToThread(thread: EarlierThreadView): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		lastThread = Number(thread.id);
		const at = thread.at;
		if (at !== null && drawnAtLines(shown, thread)) {
			await goToComment({ version: shown.version, anchor: at }, { thread: Number(thread.id) });
			return;
		}
		const card = document.querySelector<HTMLElement>(`[data-listed-thread="${String(thread.id)}"]`);
		if (card === null) return;
		scrollToTop(card);
		card.focus({ preventScroll: true });
	}

	/** Whether a thread is drawn among the lines of the version shown, and not only in the list. */
	function drawnAtLines(shown: Viewer, thread: EarlierThreadView): boolean {
		const at = thread.at;
		return (
			at !== null &&
			thread.status !== 'resolved' &&
			shown.parts.some((part) => part.part.path === at.path)
		);
	}

	/** Goes to a saved comment from the list of the draft's comments: a reply, to it in its thread. */
	async function goToListed(place: CommentPlace, what: DraftCommentView | Writing): Promise<void> {
		const reply = what instanceof Writing || what.replyTo === null ? undefined : what;
		const thread =
			reply === undefined ? undefined : viewer?.threads.find((t) => t.id === reply.replyTo);
		if (reply === undefined || thread === undefined) {
			await goToComment(place, what);
			return;
		}
		await goToThread(thread);
		document
			.querySelector<HTMLElement>(`[data-comment="${String(reply.id)}"]`)
			?.focus({ preventScroll: true });
	}

	/**
	 * Goes to the next thread of an earlier review still open among the lines,
	 * after the one last gone to, in the order they were started, back to the
	 * first after the last; says so when there is none.
	 */
	async function nextThread(): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		const open = shown.threads.filter((t) => t.status !== 'resolved');
		if (open.length === 0) {
			commentsFor(shown.id).said = 'No comment from an earlier review is open on this version.';
			return;
		}
		const after = open.findIndex((t) => Number(t.id) === lastThread);
		const next = open[after + 1] ?? open[0];
		if (next === undefined) return;
		if (after >= 0 && after + 1 >= open.length && open.length > 1) {
			commentsFor(shown.id).said = 'Back to the first comment from an earlier review.';
		}
		await goToThread(next);
	}

	/** The jump to a comment's lines under way, which a later one, or another viewer, replaces. */
	let commentJump: object | undefined;

	/**
	 * Goes to lines of the version shown that a comment is on, saved or being
	 * written: to the part of the file that owns them, opened, with the lines
	 * drawn, as a bookmark is returned to. A line among unchanged lines that
	 * are folded away gets a small window opened around it. The comment, or
	 * its box, then takes the keyboard.
	 */
	async function goToComment(
		place: CommentPlace,
		what: DraftCommentView | Writing | { readonly thread: number }
	): Promise<void> {
		const shown = viewer;
		if (shown === undefined || place.version !== shown.version) return;
		const comments = commentsFor(shown.id);
		const jump = {};
		commentJump = jump;
		const going = (): boolean => commentJump === jump && viewer === shown;
		const line: BookmarkLine = { side: place.anchor.side, line: place.anchor.last };
		const files = shown.parts.filter((part) => part.part.path === place.anchor.path);
		const name = shownPath(place.anchor.path);
		const destination = await linesHome(shown, files, line, going);
		if (!going()) return;
		const part = destination?.part ?? files[0];
		if (part === undefined) {
			comments.said = `${name} is not in this version of the Delve.`;
			return;
		}
		viewportRestore?.stop();
		if (destination !== undefined) {
			part.showLarge = true;
			part.measuring = true;
		}
		const target = { part, line };
		try {
			await goToPart(part.index, true, { stillGoing: going });
			if (destination === undefined || !going()) {
				if (going())
					comments.said = `Those lines could not be shown. This is the start of ${name}.`;
				return;
			}
			const block = destination.block;
			if (block.kind === 'hidden') {
				await shown.openBookmarkContext(part.index, destination.index, line);
				if (!going()) return;
			}
			if (block.kind === 'elsewhere') block.shown = true;
			if (block.kind === 'hunk' && wholeHunkHidden(shown.drawnLines(block)) !== undefined) {
				block.showWhiteSpace = true;
			}
			bookmarkTarget = target;
			await tick();
			await tick();
			if (!going()) return;
			const element = document.getElementById(`part-${String(part.index)}`);
			const row = element === null ? null : bookmarkedRow(element, line);
			if (row === null) {
				comments.said = `Those lines could not be shown. This is the start of ${name}.`;
				return;
			}
			scrollToTop(row);
			if (what instanceof Writing) {
				what.focusAsked += 1;
			} else if ('thread' in what) {
				element
					?.querySelector<HTMLElement>(`[data-thread="${String(what.thread)}"]`)
					?.focus({ preventScroll: true });
			} else {
				element
					?.querySelector<HTMLElement>(`[data-comment="${String(what.id)}"]`)
					?.focus({ preventScroll: true });
			}
		} finally {
			if (bookmarkTarget === target) bookmarkTarget = undefined;
			part.measuring = false;
		}
	}

	/**
	 * Where a line of the version shown is drawn: in the part of its file that
	 * owns it, else where it is drawn as context, with the parts' lines loaded.
	 */
	async function linesHome(
		shown: Viewer,
		files: readonly PartState[],
		line: BookmarkLine,
		going: () => boolean
	): Promise<BookmarkDestination | undefined> {
		let destination: BookmarkDestination | undefined;
		for (const part of files) {
			await shown.load(part.index);
			if (!going()) return undefined;
			const found = bookmarkDestination(part, line);
			if (
				found !== undefined &&
				(destination === undefined || found.priority > destination.priority)
			)
				destination = found;
			if (destination?.priority === 3) break;
		}
		return destination;
	}

	/** A place in reading order: the part, then the block and the row it is drawn in. */
	type ReadingPlace = readonly [part: number, block: number, row: number];

	function comparePlaces(a: ReadingPlace, b: ReadingPlace): number {
		return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
	}

	/** Where a line is drawn in a part whose lines are loaded; the earliest, of several. */
	function earliestPlace(
		part: PartState,
		lines: readonly BookmarkLine[]
	): ReadingPlace | undefined {
		let earliest: ReadingPlace | undefined;
		for (const line of lines) {
			const found = bookmarkDestination(part, line);
			if (found === undefined) continue;
			const place: ReadingPlace = [part.index, found.index, found.row];
			if (earliest === undefined || comparePlaces(place, earliest) < 0) earliest = place;
		}
		return earliest;
	}

	/**
	 * Where the reader is, for `F`: the line whose number the keyboard is on;
	 * the line drawn above what else in the lines has it; or else the first
	 * line of the part they are on that is on the screen; or else the start of
	 * that part. A row side by side draws a line of each side: the earlier counts.
	 */
	function readingPlace(shown: Viewer): ReadingPlace | undefined {
		const at = currentPart();
		const part = at === undefined ? undefined : shown.parts[at];
		if (part === undefined) return undefined;
		const start: ReadingPlace = [part.index, -1, -1];
		const element = document.getElementById(`part-${String(part.index)}`);
		if (element === null || part.lines.kind !== 'loaded') return start;
		const active = document.activeElement;
		if (active !== null && element.contains(active)) {
			const own = active.closest('[data-reading-line]');
			const line = own === null ? null : markedLine(own);
			if (line !== null) return earliestPlace(part, [line]) ?? start;
			// A comment is drawn under its last line: the row above it says which.
			let row = active.closest('tr');
			while (row !== null) {
				const lines = readingLines(row);
				if (lines.length > 0) return earliestPlace(part, lines) ?? start;
				row =
					row.previousElementSibling instanceof HTMLTableRowElement
						? row.previousElementSibling
						: null;
			}
		}
		const box = element.getBoundingClientRect();
		if (box.bottom <= 0 || box.top >= window.innerHeight) return start;
		const header = element.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
		const row = rowInView(element, Math.max(0, box.top, header), window.innerHeight);
		return row === null ? start : (earliestPlace(part, readingLines(row)) ?? start);
	}

	/** The `F` press under way, which a later one, or another viewer, replaces. */
	let flagJump: object | undefined;
	/** The flag `F` last went to and could not show, so the next press goes past it. */
	let unshownFlag: { readonly id: number; readonly part: number } | undefined;

	/**
	 * `F`: to the next flag on the version shown, in reading order, after the
	 * place the reader is on: by the part that draws its lines, then where they
	 * are drawn in it. After the last, back to the first. A flag on an earlier
	 * version is in the list of comments, which says so. Only a file split
	 * between parts, and the parts it must compare within, have their lines loaded.
	 */
	async function nextFlag(): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		// As of a finished review, today's draft is not shown, so its flags are not walked.
		const comments = shown.asOf === undefined ? commentsFor(shown.id) : noComments(shown.id);
		if (byFile) {
			shown.announcement = 'Flags are drawn at their lines. Choose By section to see them.';
			return;
		}
		const flags = (comments.saved ?? []).filter((c) => c.kind === 'flag');
		const here = flags.filter((f) => f.version === shown.version);
		if (here.length === 0) {
			shown.announcement =
				flags.length === 0
					? 'No lines are flagged yet. Press f on a line to flag it.'
					: 'Your flags are on lines of an earlier version. Open Draft comments to see them.';
			return;
		}
		const jump = {};
		flagJump = jump;
		const going = (): boolean => flagJump === jump && viewer === shown;
		// Where the reader is, taken before any lines are loaded.
		const from = readingPlace(shown);
		const focused = document.activeElement?.closest('[data-comment]')?.getAttribute('data-comment');
		// The flag last gone to and not shown counts as where the reader is only
		// while they have not put the keyboard on a line since.
		const onLine = document.activeElement?.closest('[data-reading-line]') != null;
		const unshown =
			unshownFlag !== undefined && unshownFlag.part === currentPart() && !onLine
				? unshownFlag.id
				: undefined;
		const on = focused == null ? unshown : Number(focused);

		// The part of each flag: its file's one part, or the one that owns its lines.
		const parted: { flag: DraftCommentView; part: PartState }[] = [];
		for (const flag of here) {
			const files = shown.parts.filter((part) => part.part.path === flag.anchor.path);
			const first = files[0];
			if (first === undefined) continue;
			if (files.length === 1) {
				parted.push({ flag, part: first });
				continue;
			}
			const line = { side: flag.anchor.side, line: flag.anchor.last };
			const home = await linesHome(shown, files, line, going);
			if (!going()) return;
			parted.push({ flag, part: home?.part ?? first });
		}

		/** The flags of one part, in the order they are drawn, with where each is. */
		type Placed = { flag: DraftCommentView; place: ReadingPlace };
		const placedIn = async (index: number): Promise<Placed[] | undefined> => {
			const inPart = parted.filter((p) => p.part.index === index);
			const part = inPart[0]?.part;
			if (part === undefined) return [];
			await shown.load(part.index);
			if (!going()) return undefined;
			return inPart
				.map(({ flag }) => ({
					flag,
					// A flag whose lines are not found is at the start of its part.
					place: earliestPlace(part, [{ side: flag.anchor.side, line: flag.anchor.last }]) ?? [
						part.index,
						-1,
						-1
					]
				}))
				.sort((a, b) => comparePlaces(a.place, b.place) || Number(a.flag.id) - Number(b.flag.id));
		};
		const parts = [...new Set(parted.map((p) => p.part.index))].sort((a, b) => a - b);

		let target: DraftCommentView | undefined;
		if (from !== undefined) {
			const same = await placedIn(from[0]);
			if (same === undefined) return;
			const after = (p: Placed): boolean => {
				const order = comparePlaces(p.place, from);
				if (on === undefined) return order >= 0;
				// From a flag: past it, and past the flags drawn with it that come before it.
				const at = same.find((q) => Number(q.flag.id) === on);
				if (at === undefined) return order >= 0;
				return (
					comparePlaces(p.place, at.place) > 0 ||
					(comparePlaces(p.place, at.place) === 0 && Number(p.flag.id) > on)
				);
			};
			target = same.find(after)?.flag;
			const later = parts.find((index) => index > from[0]);
			if (target === undefined && later !== undefined) {
				const next = await placedIn(later);
				if (next === undefined) return;
				target = next[0]?.flag;
			}
		}
		if (target === undefined) {
			const first = parts[0];
			if (first === undefined) return;
			const wrapped = await placedIn(first);
			if (wrapped === undefined) return;
			target = wrapped[0]?.flag;
			if (from !== undefined && parted.length > 1) comments.said = 'Back to the first flag.';
		}
		if (target === undefined) return;
		const flag = target;
		await goToComment(flag, flag);
		if (!going()) return;
		const shownNow = document.activeElement
			?.closest('[data-comment]')
			?.getAttribute('data-comment');
		const part = parted.find((p) => p.flag.id === flag.id)?.part.index;
		unshownFlag =
			shownNow === String(flag.id) || part === undefined
				? undefined
				: { id: Number(flag.id), part };
	}

	/**
	 * The `c`, `f` and `q` keys. On a line's number, `c` comments on that line, or on
	 * the lines taken with it, `f` flags them and `q` asks the agent about them; in the menu under them, each
	 * presses its button. Anywhere else, they go to the lines of the file the
	 * person is on, at the first one on the screen, from where the arrow keys move.
	 */
	async function commentKey(kind: 'comment' | 'flag' | 'ask'): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		if (byFile) {
			shown.announcement = `${kind === 'flag' ? 'Flags are raised' : kind === 'ask' ? 'Questions are asked' : 'Comments are written'} on lines. Choose By section to see them.`;
			return;
		}
		const on = document.activeElement;
		if (on instanceof HTMLButtonElement && on.matches('.pick-line')) {
			on.dispatchEvent(new CustomEvent('diffdelver:raise', { bubbles: true, detail: kind }));
			return;
		}
		const menu = on?.closest('[data-line-menu]');
		if (menu != null) {
			menu.querySelector<HTMLButtonElement>(`[data-raise="${kind}"]`)?.click();
			return;
		}
		const at = currentPart();
		const state = at === undefined ? undefined : shown.parts[at];
		if (at === undefined || state === undefined) return;
		if (shown.summary.state.kind !== 'open') {
			shown.announcement =
				'This Delve is closed, so its lines cannot be commented on or flagged. Reopen it first.';
			return;
		}
		const name = shownPath(state.part.path);
		if (!state.open || shown.isLarge(state)) {
			await goToPart(at, true);
			if (viewer !== shown) return;
		}
		await shown.settled(at);
		await tick();
		const part = document.getElementById(`part-${String(at)}`);
		if (part === null || viewer !== shown) return;
		const header = part.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
		const seen = lineInView(part, Math.max(stickyTop, header), window.innerHeight);
		const line =
			(seen === null
				? null
				: part.querySelector<HTMLElement>(
						`button.pick-line[data-reading-line="${seen.side}:${String(seen.line)}"]`
					)) ?? part.querySelector<HTMLElement>('button.pick-line');
		if (line === null) {
			shown.announcement = `${name} has no lines to comment on here.`;
			return;
		}
		line.focus();
		shown.announcement = `On ${line.getAttribute('aria-label')?.replace('Comment on, flag or ask about ', '') ?? 'a line'} of ${name}. Press ${kind === 'flag' ? 'f again to flag it' : kind === 'ask' ? 'q again to ask the agent about it' : 'c again to comment on it'}; the arrow keys move between lines, and Shift with them takes several.`;
	}
</script>

<svelte:head>
	<title>
		{data.loaded.ok
			? `${data.loaded.value.summary.title} in ${data.loaded.value.summary.repository} – diff delver`
			: 'Delve not found – diff delver'}
	</title>
</svelte:head>

{#if !data.loaded.ok || viewer === undefined}
	<h1>This Delve cannot be shown</h1>
	<p>{data.loaded.ok ? '' : describeApiError(data.loaded.error)}</p>
	<p><a href={resolve('/')}>See all your Delves</a></p>
{:else}
	{@const page = data.loaded.value}
	{@const summary = viewer.summary}
	{@const pull = followsPullRequest(page.source)}
	{@const pastView = page.asOf}
	{@const writable = pastView === null && summary.state.kind === 'open'}
	{@const comments = pastView === null ? commentsFor(summary.id) : noComments(summary.id)}
	{@const updated = page.update}
	{@const overall = viewer.overall}
	{@const allDone = overall.units > 0 && overall.reviewed === overall.units}
	{@const leftToRead = describeLeftToRead(overall.units - overall.reviewed, viewer.summariesLeft)}
	{@const previousVersion = previousRevisionNumber(summary.version)}
	{@const ignoredUnits = summary.progress.ignored}
	{@const stale =
		staleTick?.id === viewer.id && staleTick.version === viewer.version ? staleTick : undefined}
	{@const staleAt = stale?.part === undefined ? undefined : viewer.nearestPart(stale.part)}
	{@const staleGroup = stale?.group === undefined ? undefined : viewer.groupWithKey(stale.group)}
	<div class="viewer">
		<div class="top">
			<div class="heading">
				<h1 id={PAGE_HEADING} tabindex="-1">{summary.title}</h1>
				<span class="state {summary.state.kind}">
					{summary.state.kind === 'open' ? 'Open' : 'Closed'}
				</span>
			</div>
			<p class="details">
				<span>{summary.repository}</span>
				<span>{summary.sizeText}</span>
				{#if summary.binaryText !== null}
					<span>{summary.binaryText}</span>
				{/if}
				{#if summary.version > 1}
					<span>Version {summary.version}</span>
				{/if}
				<span>Last active {describeTimeAgo(summary.lastActivityAt, page.now)}</span>
			</p>

			{#if pastView !== null}
				<Notice tone="info" heading="As of review {pastView.review}" headingId="as-of-heading">
					<p>
						This is the Delve as it stood when you finished review {pastView.review}
						{describeTimeAgo(pastView.submittedAt, page.now)}: version {summary.version}, with what
						you had marked as reviewed then, your comments and questions for the agent as they
						stood, and the agent’s notes and answers written by then. Its overview, section
						summaries and sorting are as they are today. Nothing can be changed here.
					</p>
					{#snippet actions()}
						<a href={resolve('/diffs/[id]', { id: summary.id })}> Back to the current version </a>
						<a
							href={resolve('/diffs/[id]/reviews/[review]', {
								id: summary.id,
								review: String(pastView.review)
							})}
						>
							Read review {pastView.review}
						</a>
					{/snippet}
				</Notice>
			{:else if check.kind === 'updated'}
				<Notice heading="This Delve has a newer version" headingId="newer-heading">
					<p>
						It was updated to version {check.version} while this page was open, so what you see here,
						version
						{summary.version}, is out of date.
					</p>
					{#snippet actions()}
						<button type="button" aria-disabled={busy} onclick={showNewer}>
							Show the new version
						</button>
					{/snippet}
				</Notice>
			{:else if summary.state.kind === 'closed'}
				<Notice heading="This Delve is closed" headingId="closed-heading">
					<p>{summary.state.reason} You can still read it.</p>
					{#snippet actions()}
						<button type="button" aria-disabled={busy} onclick={() => setOpen(true)}>
							Reopen this Delve
						</button>
					{/snippet}
				</Notice>
			{:else if check.kind === 'changed'}
				<Notice
					heading={pull ? 'The pull request has changed' : 'Your files have changed'}
					headingId="changed-heading"
				>
					<p>
						{check.reason}
						{check.files === 0
							? 'None of the changes this diff shows are different, so updating brings nothing new to review.'
							: `Update to see the ${fileCount(check.files)} that changed as they are now. Lines you marked as reviewed stay marked, unless they or the lines close to them changed.`}
					</p>
					{#snippet actions()}
						<button type="button" aria-disabled={busy} onclick={update}>Update</button>
					{/snippet}
				</Notice>
			{:else if check.kind === 'nothing-left'}
				{@const next = check.next}
				<Notice heading="Nothing is left to review here" headingId="nothing-left-heading">
					<p>{check.reason}</p>
					{#snippet actions()}
						{#if next !== null}
							<button
								type="button"
								aria-disabled={busy}
								onclick={() => openNext(next, summary.directory)}
							>
								{next.offer}
							</button>
						{/if}
						<button type="button" aria-disabled={busy} onclick={() => setOpen(false)}>
							Close this Delve
						</button>
					{/snippet}
				</Notice>
			{/if}
			{#if pastView === null && summary.state.kind === 'open'}
				<p class="checked" role="status">
					{#if busy && check.kind === 'changed'}
						{pull
							? 'Updating to the pull request as it is now on GitHub…'
							: 'Updating to your files as they are now…'}
					{:else if check.kind === 'checking'}
						{pull
							? 'Checking GitHub for new commits to the pull request…'
							: 'Checking for changes in the repository…'}
					{:else if check.kind === 'unchanged'}
						{`No changes ${pull ? 'to the pull request' : 'in the repository'} since ${summary.version === 1 ? 'you opened it' : 'this version was taken'}.`}
					{:else if check.kind === 'failed'}
						Could not check for changes: {check.message}
					{/if}
				</p>
			{/if}
			{#if problem !== ''}
				<Notice tone="danger" heading="That did not work">
					<p>{problem}</p>
				</Notice>
			{/if}

			{#if updated !== null && pastView === null}
				<Notice
					tone="info"
					headingId={UPDATED_HEADING}
					heading="Updated to version {updated.version} {describeTimeAgo(updated.at, page.now)}"
				>
					<p>{updated.text}</p>
				</Notice>
			{/if}

			{#if page.leftOut.length > 0}
				<Notice heading="Some files could not be included">
					<ul>
						{#each page.leftOut as reason (reason)}
							<li>{reason}</li>
						{/each}
					</ul>
				</Notice>
			{/if}

			{#if allDone}
				<Notice tone="info" headingId={EVERYTHING_REVIEWED} heading="Everything is reviewed">
					<p>
						You have marked all {describeChanges(overall.units)} as reviewed.{ignoredUnits > 0
							? ` The ${describeChanges(ignoredUnits)} under Ignored need no review.`
							: ''}
					</p>
				</Notice>
			{/if}
		</div>

		<aside class="rail" aria-label="Your review">
			<h2 class="rail-heading">Your review</h2>
			<p class="progress-text">{progressText(overall.reviewed, overall.units)}</p>
			{#if leftToRead !== undefined}
				<p class="left-to-read">{leftToRead}</p>
			{/if}
			<ProgressBar
				tally={overall}
				label="Your review"
				text={progressText(overall.reviewed, overall.units)}
			/>
			{#if ignoredUnits > 0}
				<p class="ignored-text">{describeChanges(ignoredUnits)} ignored, not counted</p>
			{/if}
			<p class="what-counts">
				Each added line, removed line and change to a file itself, such as a rename, is one change.
			</p>
			{#if !allDone && overall.units > 0}
				<button type="button" class="primary" onclick={() => nextUnread()}>
					{overall.reviewed === 0 ? 'Start reviewing' : 'Next unread'}
					<kbd aria-hidden="true">n</kbd>
				</button>
			{/if}
			<div class="finders">
				<button type="button" onclick={openSearch}>
					Search <kbd aria-hidden="true">/</kbd>
				</button>
				<button type="button" bind:this={fileMenuButton} onclick={openFileMenu}>
					Open file <kbd aria-hidden="true">t</kbd>
				</button>
				<div class="desktop-bookmarks">{@render bookmarkButtons()}</div>
				<button
					type="button"
					onclick={() => {
						switcher.open = true;
					}}
				>
					Open another <kbd aria-hidden="true">d</kbd>
				</button>
			</div>
			<div aria-live="polite" class="bookmark-message desktop-message">{bookmarkMessage}</div>
			{#if data.canReview && (summary.version > 1 || viewer.latestReview !== null)}
				<p class="history">
					<a href={resolve('/diffs/[id]/history', { id: summary.id })}> History of this Delve </a>
				</p>
			{/if}
			{#if viewer.overview !== null}
				<details class="agent-overview" id={AGENT_OVERVIEW} tabindex="-1" open>
					<summary>Agent overview</summary>
					<AgentMarkdown markdown={viewer.overview} />
				</details>
			{/if}
			<nav aria-label="Groups">
				<ol class="groups">
					{#each viewer.groups as group (group.id)}
						{@const tally = viewer.groupTally(group)}
						<li>
							<a
								href="#{group.anchor}"
								onclick={(event) => {
									event.preventDefault();
									if (byFile) void showByFile(false);
									void tick().then(() => {
										goToGroupHeading(group.anchor);
									});
								}}
							>
								{group.name}
							</a>
							<span class="group-tally">
								{group.key.kind === 'ignored'
									? `${fileCount(group.count)}, not counted`
									: groupProgress(tally)}
							</span>
							{#if group.count > 0}
								<SectionFiles {viewer} {group} ongo={goToSectionFile} />
							{/if}
						</li>
					{/each}
				</ol>
			</nav>
			<div class="controls">
				<div class="switch" role="group" aria-label="Show the diff">
					<button type="button" aria-pressed={!byFile} onclick={() => showByFile(false)}>
						By section
					</button>
					<button type="button" aria-pressed={byFile} onclick={() => showByFile(true)}>
						By file
					</button>
				</div>
				<button
					type="button"
					aria-pressed={onlyWaiting}
					onclick={() => {
						setOnlyWaiting(!onlyWaiting);
					}}
				>
					Only what I have not reviewed
				</button>
				<div class="switch" role="group" aria-label="Show changes">
					<button
						type="button"
						aria-pressed={settings.layout === 'unified'}
						onclick={() => {
							setLayout('unified');
						}}
					>
						Unified
					</button>
					<button
						type="button"
						aria-pressed={settings.layout === 'side-by-side'}
						onclick={() => {
							setLayout('side-by-side');
						}}
					>
						Side by side <kbd aria-hidden="true">s</kbd>
					</button>
				</div>
				{#if settings.layout === 'side-by-side' && !wide}
					<p class="narrow">
						The window is too narrow for two sides, so changes are in one column.
					</p>
				{/if}
				<button
					type="button"
					aria-pressed={settings.hideWhiteSpace}
					onclick={() => {
						setHideWhiteSpace(!settings.hideWhiteSpace);
					}}
				>
					Hide white-space changes <kbd aria-hidden="true">w</kbd>
				</button>
				<button
					type="button"
					aria-pressed={settings.colours}
					onclick={() => {
						setColours(!settings.colours);
					}}
				>
					Colour the code
				</button>
				<button type="button" class="quiet" onclick={() => (helpOpen = true)}>
					Keyboard shortcuts <kbd aria-hidden="true">?</kbd>
				</button>
			</div>
		</aside>

		<div
			class="narrow-bookmarks"
			role="group"
			aria-label="Reading bookmark"
			bind:this={narrowBookmarks}
			bind:offsetHeight={dockHeight}
		>
			{@render bookmarkButtons()}
			<div aria-live="polite" class="bookmark-message">{bookmarkMessage}</div>
		</div>

		<div
			class="content"
			style:--search-height="{stickyTop}px"
			style:--dock-height="{dockHeight}px"
			role="presentation"
			onfocusin={onFocusIn}
		>
			{#if stale !== undefined && (byFile || (staleAt === undefined && staleGroup === undefined))}
				<TickRefused message={stale.message} behind={false} onshownewer={showNewer} />
			{/if}
			{#if viewer.search.open}
				<SearchBar
					search={viewer.search}
					bind:height={searchHeight}
					busy={movingToMatch}
					ontext={searchTyped}
					onstep={stepSearch}
					onclose={closeSearch}
					onoption={setSearchOption}
				/>
			{/if}
			{#if waitingForComment?.viewer === viewer}
				<p role="status">
					{waitingForComment.doing === 'choosing'
						? 'Finish choosing lines to see the updated sections.'
						: 'The sections were updated. They show here once you leave the comment you are writing.'}
				</p>
			{/if}
			{#if viewer.notes.length > 0}
				<AgentNotes
					waiting={viewer.notes.filter((n) => !n.dismissed).length}
					dismissed={viewer.notes.filter((n) => n.dismissed).length}
					shown={settings.agentNotes}
					act={data.canReview && writable}
					onshow={setShowNotes}
					onrestore={() => viewer.changeNotes({ action: 'bring-back' })}
				/>
			{:else if viewer.earlierNotes !== null}
				<p class="earlier-notes">{viewer.earlierNotes}</p>
			{/if}
			{#if data.canReview && viewer.threads.length > 0}
				<EarlierThreads
					threads={viewer.threads}
					drawn={new Set(viewer.parts.map((part) => part.part.path))}
					{comments}
					shown={viewer.version}
					act={writable}
					asOf={pastView?.review}
					ongo={goToThread}
					{showNewer}
				/>
			{/if}
			{#if otherVersions.length > 0}
				<section class="other-requests" aria-labelledby="other-requests-heading">
					<h2 id="other-requests-heading">Questions for the agent on other versions</h2>
					{#each otherVersions as request (request.id)}
						<p class="asked-on">Asked on version {request.version}</p>
						<AgentRequest {request} {viewer} {comments} act={data.canReview && writable} />
					{/each}
				</section>
			{/if}
			{#if pastView !== null}
				<!-- As of a finished review, nothing is written or finished. -->
			{:else if data.canReview}
				{#if reviewTurnedOn}
					<p class="turned-on" role="status">Comments are on in this browser now.</p>
				{/if}
				{#key summary.id}
					<CommentList
						{comments}
						version={summary.version}
						open={summary.state.kind === 'open'}
						diffHidden={byFile}
						{showNewer}
						ongo={goToListed}
						bind:control={draftsControl}
					/>
					<FinishReview
						id={summary.id}
						pullRequest={pullRequestOf(page.source)}
						{comments}
						version={summary.version}
						open={summary.state.kind === 'open'}
						onfinished={() => void refreshReview(true)}
					/>
				{/key}
			{:else}
				<ReviewAccess diff={summary.id} what="comments" />
			{/if}

			<!-- Keep the by-file list mounted through regrouping of the same version. -->
			{#key page}
				{#if fileListMade}
					<div hidden={!byFile}>
						<FileList
							{viewer}
							readOnly={pastView !== null}
							ontick={tickFile}
							ongo={goTo}
							onshownewer={showNewer}
						/>
					</div>
				{/if}
			{/key}
			<!-- New versions and regrouped parts are drawn afresh. -->
			{#key viewer}
				<div hidden={byFile}>
					{#if !anyShown}
						<p class="empty">
							{onlyWaiting
								? 'You have reviewed everything: nothing is left to show with “Only what I have not reviewed”.'
								: 'There is nothing to show.'}
						</p>
					{/if}
					{#each viewer.groups as group (group.id)}
						{@const tally = viewer.groupTally(group)}
						{@const parts = viewer.parts.slice(group.first, group.first + group.count)}
						{@const shown = parts.filter(
							(p) => (viewer.shows(p.index) && viewer.drawn(p.index)) || closingParts.has(p)
						)}
						{#if shown.length > 0 || (!onlyWaiting && group.count === 0)}
							<section class="group" id={group.anchor} aria-labelledby="{group.anchor}-heading">
								<div class="group-head">
									<h2 id="{group.anchor}-heading" tabindex="-1">{group.name}</h2>
									<span class="group-tally">
										{fileCount(group.count)}{group.key.kind === 'ignored'
											? ', not counted'
											: `, ${groupProgress(tally)}`}
									</span>
									{#if group.key.kind !== 'ignored' && tally.units > 0}
										<label class="tick">
											<input
												type="checkbox"
												aria-label="All reviewed: {group.name}"
												disabled={pastView !== null}
												checked={done(tally)}
												indeterminate={partly(tally)}
												onchange={async (event) => {
													const box = event.currentTarget;
													await tickGroup(group, box.checked);
													if (box.isConnected) showTally(box, viewer.groupTally(group));
												}}
											/>
											All reviewed
										</label>
									{/if}
								</div>
								{#if stale !== undefined && staleGroup?.id === group.id}
									<TickRefused message={stale.message} behind={false} onshownewer={showNewer} />
								{:else if viewer.refused?.kind === 'group' && viewer.refused.key === group.id}
									{@const refused = viewer.refused}
									<TickRefused
										message={refused.message}
										behind={refused.behind}
										onshownewer={showNewer}
									/>
								{/if}
								{#if group.summary !== null}
									<div
										id="{group.anchor}-summary"
										class="group-summary"
										role="region"
										aria-label="Agent summary: {group.name}"
										tabindex="-1"
									>
										<AgentMarkdown markdown={group.summary} label="Agent summary" />
									</div>
								{:else if group.key.kind === 'uncategorised'}
									<p class="explain">
										{viewer.sorted
											? agentStarted
												? 'The agent has not placed these, so they are listed here.'
												: 'The agent did not place these, so they are listed here.'
											: 'No agent has sorted this diff into sections, so every file is listed here.'}
									</p>
									{#if writable}
										<SortWithAgent
											id={summary.id}
											bind:open={agentHelpOpen}
											started={agentStarted}
										/>
									{/if}
								{:else if group.key.kind === 'ignored'}
									<p class="explain">
										These need no review and are not counted; each says why. Open one to read it.
									</p>
								{/if}
								{#if group.key.kind === 'section'}
									{@const key = group.key}
									{#each viewer.requests.filter((r) => r.version === viewer.version && r.anchor.kind === 'section' && r.anchor.section === key.section) as request (request.id)}
										<AgentRequest {request} {viewer} {comments} act={data.canReview && writable} />
									{/each}
								{/if}
								{#each shown as state (state.key)}
									<Part
										{viewer}
										{state}
										closing={closingParts.has(state)}
										bookmarkLine={bookmarkTarget?.part === state ? bookmarkTarget.line : undefined}
										{previousVersion}
										canComment={writable}
										readOnly={pastView !== null}
										canReview={data.canReview}
										{comments}
										sortingProblem={staleAt === state.index ? stale?.message : undefined}
										ontick={tickPart}
										ongo={goTo}
										onshownewer={showNewer}
										{imageMode}
										onimagemode={setImageMode}
									/>
								{/each}
							</section>
						{/if}
					{/each}
				</div>
			{/key}
			<p class="all-diffs"><a href={resolve('/')}>See all your Delves</a></p>
			{#if pastView === null}
				<OverallReview
					id={summary.id}
					{comments}
					open={summary.state.kind === 'open'}
					canReview={data.canReview}
					expanded={settings.overallReviewOpen}
					notesWaiting={viewer.notes.filter((n) => !n.dismissed).length}
					onexpand={setOverallOpen}
					onfinish={goToFinish}
					bind:height={overallHeight}
				/>
			{/if}
		</div>
	</div>
	<div class="visually-hidden" aria-live="polite">{viewer.announcement}</div>
	<div class="visually-hidden" aria-live="polite">{commentsFor(viewer.id).said}</div>
	{#if fileOpener}
		<FileOpener
			id={viewer.id}
			version={viewer.version}
			onpick={pickFile}
			onclose={cancelFileMenu}
		/>
	{/if}
	{#if readerPath.ok && readerSide.ok && readerVersion.ok}
		{#key `${viewer.id}:${readerVersion.value}:${readerSide.value}:${readerPath.value}`}
			<FileReader
				id={viewer.id}
				version={readerVersion.value}
				path={readerPath.value}
				side={readerSide.value}
				colour={settings.colours}
				onclose={closeFile}
				onswitch={switchFile}
				onjump={jumpFromFile}
			/>
		{/key}
	{/if}
	<Shortcuts bind:open={helpOpen} />
{/if}

{#snippet bookmarkButtons()}
	<button type="button" onclick={markReadingPlace}>
		Bookmark this spot <kbd aria-hidden="true">b</kbd>
	</button>
	{#if bookmark !== undefined}
		<button type="button" class="bookmark-return" onclick={returnToBookmark}>
			<span>
				Return to bookmark <span class="bookmark-path">{shownPath(bookmark.path)}</span>
			</span>
			<kbd aria-hidden="true">Shift+B</kbd>
		</button>
	{/if}
{/snippet}

<svelte:window onkeydown={onKey} />

<style>
	:global(main:has(.viewer)) {
		max-width: 92rem;
	}

	.viewer {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		grid-template-areas: 'top top' 'rail content';
		gap: 0 2rem;
	}

	.top {
		grid-area: top;
	}

	.rail {
		grid-area: rail;
		position: sticky;
		top: 1rem;
		align-self: start;
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		padding: 0.25rem 0.25rem 1rem;
		font-size: 0.875rem;
	}

	.content {
		grid-area: content;
		min-width: 0;
		margin-top: 1rem;
	}

	.turned-on {
		margin: 0 0 0.5rem;
		color: var(--color-muted);
	}

	.desktop-bookmarks {
		display: contents;
	}
	.narrow-bookmarks {
		display: none;
	}

	@media (max-width: 60rem) {
		.viewer {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'top' 'rail' 'content';
		}

		.rail {
			position: static;
			max-height: none;
		}

		.desktop-bookmarks,
		.desktop-message {
			display: none;
		}

		.narrow-bookmarks {
			position: fixed;
			inset: auto 0 0;
			z-index: 3;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5rem;
			padding: 0.5rem 1rem max(0.5rem, env(safe-area-inset-bottom));
			border-top: 1px solid var(--color-border);
			background: var(--color-background);
			font-size: 0.875rem;
			max-height: 40vh;
			overflow-y: auto;
		}

		.narrow-bookmarks .bookmark-message {
			flex-basis: 100%;
		}
		.narrow-bookmarks .bookmark-message:empty {
			display: none;
		}
		.content {
			padding-bottom: 9rem;
		}
	}

	.heading {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
	}

	.state {
		font-size: 0.875rem;
		font-weight: 700;
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.6rem;
	}

	.state.open {
		color: var(--color-added);
		border-color: var(--color-added);
	}

	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin: 0.5rem 0 0;
		color: var(--color-muted);
	}

	.checked {
		margin: 0.5rem 0 0;
		min-height: 1.5rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.rail-heading {
		font-size: 1rem;
		margin: 1rem 0 0.25rem;
	}

	.progress-text {
		margin: 0 0 0.35rem;
		font-weight: 700;
	}

	.left-to-read {
		margin: 0 0 0.35rem;
	}

	.ignored-text,
	.what-counts {
		margin: 0.35rem 0 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.primary {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin-top: 0.75rem;
		padding: 0.4rem 0.9rem;
		background: var(--color-primary-button);
		border-color: var(--color-primary-button);
		color: var(--color-on-primary-button);
	}

	.primary:hover {
		background: var(--color-primary-button-hover);
	}

	kbd {
		font-size: 0.75rem;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-weight: 400;
		opacity: 0.8;
	}

	.history {
		margin: 0.5rem 0 0;
		font-size: 0.875rem;
	}

	.finders {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.finders button,
	.narrow-bookmarks button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.bookmark-return {
		max-width: 100%;
		text-align: left;
	}

	.bookmark-path {
		display: block;
		overflow-wrap: anywhere;
	}

	.bookmark-message:not(:empty) {
		margin-top: 0.5rem;
		overflow-wrap: anywhere;
	}

	.agent-overview {
		border-block-start: 1px solid var(--color-border);
		margin-block-start: 1rem;
		padding-block-start: 0.65rem;
	}

	.agent-overview summary {
		cursor: pointer;
		font-weight: 700;
	}

	.groups {
		list-style: none;
		margin: 1rem 0 0;
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	.groups li {
		display: flex;
		flex-direction: column;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--color-border);
	}

	.groups a {
		font-weight: 700;
	}

	.group-tally {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.groups .group-tally::first-letter {
		text-transform: uppercase;
	}

	.controls {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.switch {
		display: flex;
	}

	.switch button:first-child {
		border-radius: 6px 0 0 6px;
	}

	.switch button:last-child {
		border-radius: 0 6px 6px 0;
		border-left: 0;
	}

	button[aria-pressed='true'] {
		background: var(--color-selected-button);
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.quiet {
		font-weight: 400;
	}

	.narrow {
		margin: 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.group {
		margin-bottom: 1.5rem;
	}

	.group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.25rem;
	}

	.group-head h2 {
		font-size: 1.125rem;
		margin: 0;
		scroll-margin-top: 1rem;
	}

	.group-head .tick {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-weight: 700;
		font-size: 0.875rem;
	}

	.tick input {
		width: 1rem;
		height: 1rem;
		margin: 0;
	}

	.explain {
		margin: 0 0 0.75rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.empty {
		color: var(--color-muted);
	}

	.other-requests {
		margin-block: 0.75rem;
		max-width: 48rem;
	}

	.other-requests h2 {
		margin: 0;
		font-size: 1rem;
	}

	.asked-on {
		margin: 0.5rem 0 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.earlier-notes {
		margin-block: 0.75rem;
		max-width: 46rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.all-diffs {
		margin-top: 2rem;
	}
</style>
