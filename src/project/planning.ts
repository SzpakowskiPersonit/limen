import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Where planning files live: committed to Git (the default), or private in the canonical project root. */
export type PlanningSource = "committed" | "private";

/** The project setting is local cabinet state in `.limen/planning-source`, never a copy of planning files. */
export function planningSource(root: string): PlanningSource {
	return parsePlanningSource(readIfPresent(`${root}/.limen/planning-source`)?.trim() ?? "committed");
}

/** A job keeps the source recorded at spawn, even after the project setting changes. */
export function recordedPlanningSource(jobDir: string): PlanningSource {
	return parsePlanningSource(readIfPresent(`${jobDir}/planning-source`)?.trim() ?? "committed");
}

export function parsePlanningSource(value: string): PlanningSource {
	if (value !== "committed" && value !== "private") {
		throw new Error("planning source must be committed or private");
	}
	return value;
}

/** Inside a job's own worktree, return the canonical root, recorded source, and workspace repository from its job record. */
export function inheritedPlanning(
	worktree: string,
): { root: string; source: PlanningSource; repo?: string } | undefined {
	const root = process.env.LIMEN_CONTEXT_ROOT;
	const id = process.env.LIMEN_JOB_ID;
	if (process.env.LIMEN_JOB !== "1" || !root || !id || !/^[A-Za-z0-9._-]+$/.test(id)) {
		return;
	}
	const jobDir = `${root}/.limen/jobs/${id}`;
	if (resolve(readFileSync(`${jobDir}/worktree`, "utf8").trim()) !== resolve(worktree)) {
		return;
	}
	const repo = readIfPresent(`${jobDir}/repo`)?.trim();
	return { root, source: recordedPlanningSource(jobDir), ...(repo ? { repo } : {}) };
}

/** Return the absolute path of a readable planning file inside the canonical root. Reject `..` and symlink escapes before the read. */
export async function privatePlanningFile(root: string, path: string): Promise<string> {
	const absolute = resolve(root, path);
	if (path.split(/[\\/]/).includes("..") || !inside(resolve(root), absolute)) {
		throw new Error(`private planning path must be inside canonical root: ${path}`);
	}
	const canonicalRoot = await realpath(root);
	const file = await realpath(absolute);
	if (!inside(canonicalRoot, file)) {
		throw new Error(`private planning path escapes canonical root: ${path}`);
	}
	const info = await stat(file);
	if (!info.isFile() || !(info.mode & 0o444)) {
		throw new Error(`private planning file is not readable: ${path}`);
	}
	await readFile(file, "utf8");
	return absolute;
}

/**
 * Read every `Ticket:` directive path, preserving order and excluding sentence punctuation. A directive starts a line
 * (after at most three spaces and an optional list marker) or a new sentence. Text in a fenced block, a code span,
 * a block quote or quotation marks only mentions a pointer, so it holds none. `start` is the path's offset in `task`.
 */
export function ticketPointers(task: string): Array<{ path: string; start: number }> {
	const prose = proseOnly(task);
	const directive = /(?:^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?|(?<=[.!?])[ \t]+)Ticket:[ \t]+([^\s\0]+)(?=\s|$)/gm;
	return [...prose.matchAll(directive)].flatMap((match) => {
		const [whole, token = ""] = match;
		const path = token.replace(/[.,;:!?)\]'"`]+$/, "");
		const start = match.index + whole.length - token.length;
		return path ? [{ path, start }] : [];
	});
}

/** Replace each `Ticket:` path in place; `rewrite` returns the new path, or undefined to keep it. */
export function rewriteTicketPaths(task: string, rewrite: (path: string) => string | undefined): string {
	let result = task;
	for (const { path, start } of ticketPointers(task).reverse()) {
		const next = rewrite(path);
		if (next !== undefined) {
			result = `${result.slice(0, start)}${next}${result.slice(start + path.length)}`;
		}
	}
	return result;
}

/** Check each `Ticket:` path in the task and replace it with its absolute path in the canonical root. */
export async function privatePlanningTask(root: string, task: string): Promise<string> {
	const absolute = new Map<string, string>();
	for (const { path } of ticketPointers(task)) {
		absolute.set(path, await privatePlanningFile(root, path));
	}
	return rewriteTicketPaths(task, (path) => absolute.get(path));
}

/** The task with every fenced block, block-quote line, code span and quoted run turned to NUL, offsets unchanged. */
function proseOnly(task: string): string {
	const blank = (text: string) => text.replace(/[^\n]/g, "\0");
	let fence: string | undefined;
	const lines = task.split("\n").map((line) => {
		const [, marker = "", rest = ""] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
		if (fence) {
			if (marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) {
				fence = undefined;
			}
			return blank(line);
		}
		if (marker && !(marker[0] === "`" && rest.includes("`"))) {
			fence = marker;
			return blank(line);
		}
		return /^ {0,3}>/.test(line) ? blank(line) : line;
	});
	return lines
		.join("\n")
		.replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, blank)
		.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, blank);
}

/** System-prompt lines for a session that reads private planning from the canonical root. */
export function privatePlanningGuidance(root: string): string {
	return [
		`Planning source: private. Read canonical planning in ${root}; do not copy, link, stage or commit it. Planning-commit instructions apply only to committed mode. Product-code Git requirements are unchanged.`,
		`Vision (read-only): ${root}/spec/vision.md`,
		`Board (read-only): ${root}/spec/build.md`,
		"",
	].join("\n");
}

function inside(base: string, file: string): boolean {
	const path = relative(base, file);
	return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function readIfPresent(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
}
