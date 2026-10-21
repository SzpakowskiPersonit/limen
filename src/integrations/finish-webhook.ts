import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Handoff } from "../job/handoff.ts";
import { isTerminal, type TerminalState } from "../job/job.ts";
import { textFile } from "../job/record.ts";
import { currentBranch, listWorktrees, ticketAuthor, workspaceRoot } from "../project/git.ts";
import { ticketPointers } from "../project/planning.ts";
import { finishEvent, GITHUB_AUTHOR, GITHUB_NOREPLY } from "./finish-receipt.ts";
import { queuePing, SENDER, senderEnvironment } from "./webhook-queue.ts";

/** One plant webhook: what happened (`kind`), to what (`title`, `id`), where (`plant`), and why (`reason`). `status` is the sender's state argument. */
export type PlantEvent = {
	readonly kind: string;
	readonly status: string;
	readonly title: string;
	readonly id: string;
	readonly reason: string;
	readonly branch: string;
	readonly plant: string;
	readonly author?: string;
	readonly handoff?: string;
	readonly prUrl?: string;
};
export function finishWebhookEnv(root: string, cwd: string, explicit = process.env.LIMEN_FINISH_WEBHOOK_ENV): string {
	if (explicit !== undefined) {
		return explicit.trim() ? resolve(cwd, explicit) : "";
	}
	const project = workspaceRoot(root) ? root : (listWorktrees(root)[0]?.path ?? root);
	const path = resolve(project, ".limen/finish-webhook.env");
	return existsSync(path) ? path : "";
}
export function captureFinishAuthor(cwd: string, task: string, workspace = false): string {
	if (workspace) {
		return "unavailable\nnon-Git workspace ticket";
	}
	const tickets = ticketPointers(task);
	const ticket = tickets.length === 1 ? tickets[0]?.path : undefined;
	if (!ticket) {
		return `unavailable\n${tickets.length ? "ambiguous Ticket: pointer" : "missing Ticket: pointer"}`;
	}
	try {
		const author = ticketAuthor(cwd, ticket);
		const login = GITHUB_NOREPLY.exec(author.email)?.[1];
		return login ? `@${login.toLowerCase()}\n${author.commit}` : `unavailable\nordinary email\n${author.commit}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const reason = AUTHOR_LOOKUP_REASONS.find(([needle]) => message.includes(needle))?.[1] ?? "lookup failed";
		return `unavailable\n${reason}`;
	}
}
const AUTHOR_LOOKUP_REASONS = [
	["shallow", "shallow history"],
	["not a committed file", "uncommitted ticket"],
	["must be a file inside", "ticket path outside repository"],
	["no creation author", "no creation author"],
] as const;
/** A terminal job claims its one finish ping, then the queue sends it until every target answers for good. */
export async function deliverFinishWebhook(jobDir: string, detail = ""): Promise<void> {
	const config = await textFile(`${jobDir}/finish-webhook-env`);
	if (!config) {
		return;
	}
	const state = await textFile(`${jobDir}/state`);
	if (!isTerminal(state)) {
		return;
	}
	try {
		await writeFile(`${jobDir}/finish-webhook-attempt`, `${state} ${new Date().toISOString()}\n`, {
			flag: "wx",
			mode: 0o600,
			flush: true,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return;
		}
		throw error;
	}
	const handoff = await readHandoff(jobDir);
	// A done job's reason is its handoff's first text line, without Markdown markers; every other end names the finish detail, which is the failed gate.
	const summary =
		state === "done"
			? ((await textFile(`${jobDir}/result`))
					.split("\n")
					.map((line) => line.replace(/^[\s#>*-]+/, "").trim())
					.find(Boolean) ?? "")
			: "";
	const status = handoff.status === "incomplete" ? "incomplete" : state;
	const event: PlantEvent = {
		...(await jobFields(jobDir)),
		kind: handoff.follow_up
			? "job.review-failed"
			: status === "incomplete"
				? "job.incomplete"
				: terminalKind(state, detail),
		status,
		reason:
			status === "incomplete"
				? (handoff.reason ?? detail)
				: [summary || detail || state, handoff.unpushed ? handoff.reason : ""].filter(Boolean).join("; "),
		...(status === "incomplete"
			? { handoff: "Job stopped at a budget checkpoint; the work is not finished. Next step: continue it." }
			: handoff.follow_up
				? { handoff: `Review ${handoff.verdict}. Next step: repair it from the follow-up ${handoff.follow_up}.` }
				: {}),
		...(handoff.pr_url ? { prUrl: handoff.pr_url } : {}),
	};
	await queuePing(resolve(jobDir, "../.."), jobDir, config, event, finishEvent(jobDir), jobDir);
}
async function readHandoff(jobDir: string): Promise<Partial<Handoff>> {
	try {
		return JSON.parse(await readFile(`${jobDir}/handoff.json`, "utf8")) as Partial<Handoff>;
	} catch {
		return {};
	}
}
/** Timeouts and stalled tools end a job as failed; the webhook names the gate that ended it. */
function terminalKind(state: TerminalState, detail: string): string {
	if (state === "failed" && detail.startsWith("timeout after ")) {
		return "job.timed-out";
	}
	if (state === "failed" && detail.startsWith("stalled tool ")) {
		return "job.stalled";
	}
	return `job.${state}`;
}
async function jobFields(jobDir: string): Promise<Omit<PlantEvent, "kind" | "status" | "reason">> {
	const [title, branch, author] = await Promise.all([
		textFile(`${jobDir}/label`),
		textFile(`${jobDir}/branch`),
		textFile(`${jobDir}/finish-webhook-author`),
	]);
	const login = author.split("\n")[0] ?? "";
	return {
		title,
		id: basename(jobDir),
		branch,
		plant: basename(resolve(jobDir, "../../..")),
		author: GITHUB_AUTHOR.test(login) ? login.toLowerCase() : "",
	};
}
/** A hosted stall pings once per advisory while the job still runs; a job that ends first sends only its terminal ping. */
export async function deliverJobStall(jobDir: string, line: string): Promise<void> {
	const config = await textFile(`${jobDir}/finish-webhook-env`);
	if (!config || (await textFile(`${jobDir}/state`)) !== "running") {
		return;
	}
	const handoff = "Job stalled while running. Next step: read the job, then steer it, stop it, or wait.";
	const event: PlantEvent = {
		...(await jobFields(jobDir)),
		kind: "job.stalled",
		status: "stalled",
		reason: line,
		handoff,
	};
	await deliverEventWebhook(
		`${jobDir}/events/job.stalled.${Date.now()}`,
		config,
		event,
		resolve(jobDir, "../.."),
		jobDir,
	);
}
/** A non-terminal event is claimed once by creating `dir`; its receipt stays beside the claim. Without config the claim records the skip. */
export async function deliverEventWebhook(
	dir: string,
	config: string,
	event: PlantEvent,
	limen: string,
	log = "",
): Promise<void> {
	await mkdir(dirname(dir), { recursive: true });
	try {
		await mkdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return;
		}
		throw error;
	}
	if (!config) {
		await writeFile(
			`${dir}/finish-webhook`,
			`skipped: no finish webhook config; not sent ${new Date().toISOString()}\n`,
		);
		return;
	}
	await queuePing(limen, dir, config, event, `limen-finish-${createHash("sha256").update(dir).digest("hex")}`, log);
}
/** `limen webhook test`: one synthetic event through the real sender, with its per-target lines on this terminal. */
export function sendTestPing(root: string, config: string): number {
	const at = new Date().toISOString();
	const event: PlantEvent = {
		kind: "webhook.test",
		status: "test",
		title: "limen webhook test",
		id: `webhook-test-${at}`,
		reason: `manual test ping from ${hostname()} at ${at}`,
		branch: plantBranch(root),
		plant: basename(root),
		handoff: "Test ping from limen webhook test. No action needed.",
	};
	const result = spawnSync(SENDER, [event.title, event.status, event.branch], {
		env: senderEnvironment(config, event),
		stdio: ["ignore", "inherit", "inherit"],
		timeout: 15_000,
	});
	return result.status ?? 1;
}
export function plantBranch(root: string): string {
	try {
		return currentBranch(root);
	} catch {
		// A detached plant root has no branch name; the payload still names HEAD.
		return "HEAD";
	}
}
/** A finished lead group step sends through the job sender once; its directory under the group cabinet is the receipt. */
export async function deliverLeadStepWebhook(
	stepDir: string,
	root: string,
	feature: string,
	step: "synthesis" | "close",
): Promise<void> {
	const config = finishWebhookEnv(root, root);
	if (!config) {
		return;
	}
	await mkdir(stepDir, { recursive: true });
	try {
		await writeFile(`${stepDir}/finish-webhook-attempt`, `done ${new Date().toISOString()}\n`, {
			flag: "wx",
			mode: 0o600,
			flush: true,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return;
		}
		throw error;
	}
	const name = basename(feature);
	const label = `${/^F\d+/.exec(name)?.[0] ?? name} lead ${step}`;
	const next = step === "close" ? "owner decision" : "owner decision on group/synthesis.md, or close the group";
	const handoff = `Lead step done: ${label}. Next step: ${next}.`;
	const login = captureFinishAuthor(root, `Ticket: ${feature}/ticket.md`).split("\n")[0] ?? "";
	const event: PlantEvent = {
		kind: "lead.step-done",
		status: "done",
		title: label,
		id: basename(stepDir),
		reason: step === "close" ? "group closed" : `${feature}/group/synthesis.md changed`,
		branch: plantBranch(root),
		plant: basename(root),
		author: login.startsWith("@") ? login : "",
		handoff,
	};
	await queuePing(join(root, ".limen"), stepDir, config, event, finishEvent(stepDir));
}
