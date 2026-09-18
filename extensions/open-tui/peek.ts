import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IconGlyphs } from "./icons.ts";
import { sanitizeStatus } from "./utils.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PEEK_LINES = 4;
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
export function reducePeek(prev: PeekState, parts: PeekMessageParts): PeekState {
	const tail = parts.thinking ? peekTail(parts.thinking, MAX_PEEK_LINES) : prev.tail;
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
 * Extract the last non-empty logical lines of the thinking text, whitespace-
 * normalized. NOT width-bounded: clipping to the terminal happens at render
 * time in buildPeekLabel/clipTail, so wide terminals get to see more of it.
 */
export function peekTail(fullThinking: string, lineCount = 1): string {
	if (!fullThinking) return "";
	const count = normalizePeekLineCount(lineCount);
	const lines: string[] = [];
	let end = fullThinking.length;
	while (end > 0 && lines.length < count) {
		const start = fullThinking.lastIndexOf("\n", end - 1) + 1;
		const line = fullThinking.slice(start, end).replace(/\s+/g, " ").trim();
		if (line) lines.push(line);
		end = start - 1;
	}
	return lines.reverse().join("\n");
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
): string {
	const w = Math.max(1, Math.floor(width));
	const prefix = `${glyphs.thinking} think`;
	const count = normalizePeekLineCount(lineCount);
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
				.slice(-count);
			const latest = safeLines.at(-1) ?? "";
			const lineWithMarker = (tail: string): string => fit(tail ? `${marker} ${tail}` : marker);
			const renderRows = (rows: string[]): string =>
				rows
					.map((row, index) => (index === 0 ? lineWithMarker(row) : fit(`${thoughtIndent}${row}`)))
					.join("\n");
			if (count >= 2) {
				const window = clipTail(latest, contentWidth * count);
				const latestWrapped = wrapTextWithAnsi(window, Math.max(1, contentWidth));
				if (latestWrapped.length > 1) {
					// Word wrapping may add short rows; always retain the newest content.
					return renderRows(latestWrapped.slice(-count));
				}
			}
			const firstTail = clipTail(count >= 2 ? safeLines[0] ?? "" : latest, contentWidth);
			if (count < 2 || safeLines.length < 2) return lineWithMarker(firstTail);
			// Align the latest line with the first line's thinking text, not with
			// the status marker.
			return renderRows(safeLines.slice(-count).map((line) => clipTail(line, contentWidth)));
		}
		case "done":
			return fit(`${prefix} ${glyphs.done}`);
		default:
			return fit(`${prefix} ·`);
	}
}
