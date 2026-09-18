import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IconGlyphs } from "./icons.ts";
import { sanitizeStatus } from "./utils.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PEEK_LINES = 6;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type PeekPhase = "idle" | "thinking" | "done";

export interface PeekState {
	phase: PeekPhase;
	tail: string;
}

export interface PeekMessageParts {
	thinking: string;
	text: string;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const normalizePeekLineCount = (lineCount: number): number => Math.max(1, Math.min(MAX_PEEK_LINES, Math.floor(lineCount)));

/**
 * Pure phase machine for one assistant-message update.
 *
 * Thinking text is cumulative: once the answer starts, later updates still
 * carry the full thinking block alongside new text. To keep the spinner honest:
 * - idle + thinking        -> thinking (spinner starts)
 * - idle + thinking + text -> done    (already answered, never spin)
 * - thinking + text        -> done    (answer started: stop spinner)
 * - done + thinking        -> done    (never restart the spinner)
 * - any + text only        -> idle stays idle (plain answer, nothing to peek)
 */
export function reducePeek(
	prev: PeekState,
	parts: PeekMessageParts,
	lineCount = MAX_PEEK_LINES,
	headLineCount = 0,
): PeekState {
	const tail = parts.thinking ? peekTail(parts.thinking, lineCount, headLineCount) : prev.tail;
	let phase = prev.phase;
	if (parts.thinking && phase === "idle") phase = "thinking";
	if (parts.text && phase === "thinking") phase = "done";
	return { phase, tail };
}

/** Fresh peek state (no task running yet). */
export function createPeekState(): PeekState {
	return { phase: "idle", tail: "" };
}

/**
 * Collect the running thinking text and answer text from an assistant
 * message's content parts. Thinking arrives token-by-token, so re-calling
 * this on every `message_update` yields the cumulative text.
 */
export function collectPeekParts(content: unknown): PeekMessageParts {
	let thinking = "";
	let text = "";
	if (!Array.isArray(content)) return { thinking, text };
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as { type?: unknown; thinking?: unknown; text?: unknown };
		if (part.type === "thinking") {
			thinking += stringValue(part.thinking) ?? stringValue(part.text) ?? "";
		} else if (part.type === "text") {
			text += stringValue(part.text) ?? "";
		}
	}
	return { thinking, text };
}

/**
 * Extract the non-empty logical lines of the thinking text, whitespace-
 * normalized: the opening `headLineCount` lines (pinned head) followed by the
 * last `lineCount - headLineCount` lines (scrolling tail). NOT width-bounded:
 * clipping to the terminal happens at render time in buildPeekLabel/clipTail,
 * so wide terminals get to see more of it.
 */
export function peekTail(fullThinking: string, lineCount = 1, headLineCount = 0): string {
	if (!fullThinking) return "";
	const count = normalizePeekLineCount(lineCount);
	const requestedHead = Number.isFinite(headLineCount) ? Math.floor(headLineCount) : 0;
	const head = Math.max(0, Math.min(requestedHead, count));
	const tail = count - head;

	// Common case (no pinned head): walk backwards and avoid indexing every line.
	const tailLines: string[] = [];
	let end = fullThinking.length;
	while (end > 0 && tailLines.length < tail) {
		const start = fullThinking.lastIndexOf("\n", end - 1) + 1;
		const line = fullThinking.slice(start, end).replace(/\s+/g, " ").trim();
		if (line) tailLines.push(line);
		end = start - 1;
	}
	tailLines.reverse();

	if (head === 0) return tailLines.join("\n");

	// A pinned head needs the opening lines, so only then scan the whole text.
	// Short thinking is returned in full instead of duplicating lines.
	const allLines: string[] = [];
	for (const raw of fullThinking.split("\n")) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (line) allLines.push(line);
	}
	if (allLines.length <= count) return allLines.join("\n");
	const tailPart = tail > 0 ? allLines.slice(-tail) : [];
	return [...allLines.slice(0, head), ...tailPart].join("\n");
}

/**
 * Clip a tail string to `budget` visible columns, keeping the END (it is a
 * tail view) and prefixing "…" when clipped. Walk backwards over complete
 * graphemes so measurement is limited to the visible suffix.
 */
export function clipTail(text: string, budget: number): string {
	if (!text || budget <= 0) return "";
	const limit = budget - 1; // reserve one column for the ellipsis
	let w = 0;
	let end = text.length;
	let clippedStart = end;
	const segments = graphemeSegmenter.segment(text);
	while (end > 0) {
		const part = segments.containing(end - 1)!;
		w += visibleWidth(part.segment);
		if (w > budget) return "…" + text.slice(clippedStart);
		end = part.index;
		if (w <= limit) clippedStart = end;
	}
	return text;
}

/**
 * Build the label Pi renders in its hidden-thinking block. `width` is a
 * conservative budget that keeps each native Text row within the terminal.
 * In multi-line mode, an overflowing latest logical line uses the available
 * rows for its continuation instead of retaining earlier logical lines.
 */
export function buildPeekLabel(
	state: PeekState,
	frame: number,
	glyphs: IconGlyphs,
	width: number,
	lineCount = 1,
	headLineCount = 0,
): string {
	const w = Math.max(1, Math.floor(width));
	const prefix = `${glyphs.thinking} think`;
	const count = normalizePeekLineCount(lineCount);
	const requestedHead = Number.isFinite(headLineCount) ? Math.floor(headLineCount) : 0;
	const head = Math.max(0, Math.min(requestedHead, count));
	const fit = (line: string): string => truncateToWidth(line, w, "…");
	switch (state.phase) {
		case "thinking": {
			const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
			// Thinking text is model output (untrusted): strip terminal control
			// sequences before placing it in Pi's native label.
			const marker = `${prefix} ${spin}`;
			const markerWidth = visibleWidth(`${marker} `);
			const contentWidth = Math.max(0, w - markerWidth);
			const thoughtIndent = " ".repeat(markerWidth);
			const safeLines = state.tail
				.split("\n")
				.map((tail) => sanitizeStatus(tail))
				.filter(Boolean)
				.slice(0, count);
			const lineWithMarker = (tail: string): string => fit(tail ? `${marker} ${tail}` : marker);
			const renderRows = (rows: string[]): string =>
				rows
					.map((row, index) => (index === 0 ? lineWithMarker(row) : fit(`${thoughtIndent}${row}`)))
					.join("\n");

			// Pinned head: keep the opening lines of the thinking text visible so the
			// label does not shift on every token.
			const headRows = safeLines.slice(0, head).map((line) => clipTail(line, contentWidth));
			const tailLines = safeLines.slice(head);
			if (tailLines.length === 0) return headRows.length > 0 ? renderRows(headRows) : fit(marker);

			const tailBudget = Math.max(1, count - headRows.length);
			const latest = tailLines.at(-1) ?? "";
			const window = clipTail(latest, contentWidth * tailBudget);
			const latestWrapped = wrapTextWithAnsi(window, Math.max(1, contentWidth));
			// Word wrapping may add short rows; always retain the newest content.
			// Wrapping stays inside the tail budget so the head rows survive.
			const tailRows = latestWrapped.length > 1
				? latestWrapped.slice(-tailBudget)
				: tailLines.slice(-tailBudget).map((line) => clipTail(line, contentWidth));
			return renderRows([...headRows, ...tailRows]);
		}
		case "done":
			return fit(`${prefix} ${glyphs.done}`);
		default:
			return fit(`${prefix} ·`);
	}
}
