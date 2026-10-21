import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listWorktrees, workspaceRoot } from "./git.ts";
import { appendLimenLog, atomicWrite, textFile } from "./wrapper.ts";

const SENDER = fileURLToPath(new URL("../bin/tony-finish-ping.sh", import.meta.url));
// Shorter than the detached wrapper's 5s termination grace, including a hung sender.
const SEND_MS = 3_000;
export function finishWebhookEnv(root: string, cwd: string, explicit = process.env.TONY_FINISH_WEBHOOK_ENV): string {
	if (explicit !== undefined) return explicit.trim() ? resolve(cwd, explicit) : "";
	const project = workspaceRoot(root) ? root : (listWorktrees(root)[0]?.path ?? root);
	const path = resolve(project, ".limen/finish-webhook.env");
	return existsSync(path) ? path : "";
}
export async function deliverFinishWebhook(jobDir: string, shutdownDeadline = Number.POSITIVE_INFINITY): Promise<void> {
	const config = await textFile(`${jobDir}/finish-webhook-env`);
	if (!config) return;
	const state = await textFile(`${jobDir}/state`);
	if (!["done", "failed", "stopped"].includes(state)) return;
	try {
		// Never reclaim: a crash after HTTP acceptance but before recording it is ambiguous.
		await writeFile(`${jobDir}/finish-webhook-attempt`, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600, flush: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		throw error;
	}
	const retry =
		"Manual finish-ping retry: inspect finish-webhook-attempt and finish-webhook; use bin/tony-finish-ping.sh with this job's finish-webhook-env, label, state and branch. Acceptance is not proof of owner wake; an interrupted attempt may already have sent.";
	await atomicWrite(`${jobDir}/finish-webhook`, `attempting ${new Date().toISOString()}\n${retry}\n`);
	await appendLimenLog(jobDir, "finish webhook: attempting; inspect finish-webhook for status and manual finish-ping retry");
	const timeoutMs = Math.min(SEND_MS, shutdownDeadline - Date.now());
	const result = !isAbsolute(config)
		? "failed: config path is not absolute"
		: timeoutMs <= 0
			? "failed: no shutdown time remains; not sent"
			: await sendJob(jobDir, config, state, timeoutMs);
	await atomicWrite(`${jobDir}/finish-webhook`, `${result} ${new Date().toISOString()}\n${retry}\n`);
	await appendLimenLog(jobDir, `finish webhook: ${result}; inspect finish-webhook for manual finish-ping retry`);
	if (retryable(config, result)) await atomicWrite(`${jobDir}/finish-webhook-outbox`, `1 ${Date.now() + backoffMs(1)}\n`);
}
// A sender that may have been accepted is never resent; only a definite failure enters the outbox.
const retryable = (config: string, result: string) => isAbsolute(config) && result.startsWith("failed: ") && !result.includes("acceptance unknown");
const RETRY_ATTEMPTS = 5;
function backoffMs(attempt: number): number {
	const base = Number(process.env.LIMEN_FINISH_RETRY_MS);
	return (Number.isFinite(base) && base >= 0 ? base : 60_000) * 2 ** (attempt - 1);
}
export async function retryFinishWebhooks(jobsDir: string, now = Date.now()): Promise<void> {
	for (const name of await readdir(jobsDir).catch(() => [])) {
		const jobDir = join(jobsDir, name);
		const [attemptText, dueText] = (await textFile(`${jobDir}/finish-webhook-outbox`)).split(" ");
		const attempts = Number(attemptText);
		if (!attempts || !(Number(dueText) <= now)) continue;
		const [config, state] = await Promise.all([textFile(`${jobDir}/finish-webhook-env`), textFile(`${jobDir}/state`)]);
		const result = await sendJob(jobDir, config, state, SEND_MS);
		await appendFile(`${jobDir}/finish-webhook`, `retry ${attempts}: ${result} ${new Date().toISOString()}\n`);
		await appendLimenLog(jobDir, `finish webhook: retry ${attempts}: ${result}`);
		if (!retryable(config, result) || attempts >= RETRY_ATTEMPTS) {
			if (retryable(config, result)) await appendLimenLog(jobDir, `finish webhook: gave up after ${attempts} retries`);
			await rm(`${jobDir}/finish-webhook-outbox`, { force: true });
		} else await atomicWrite(`${jobDir}/finish-webhook-outbox`, `${attempts + 1} ${now + backoffMs(attempts + 1)}\n`);
	}
}
async function sendJob(jobDir: string, config: string, state: string, timeoutMs: number): Promise<string> {
	const [label, branch, status] = await Promise.all([textFile(`${jobDir}/label`), textFile(`${jobDir}/branch`), handoffStatus(jobDir, state)]);
	const handoff = existsSync(`${jobDir}/handoff.json`) ? [resolve(jobDir, "handoff.json")] : [];
	return send(config, [label, status, branch, ...handoff], timeoutMs);
}
async function handoffStatus(jobDir: string, state: string): Promise<string> {
	try {
		const status = JSON.parse(await readFile(`${jobDir}/handoff.json`, "utf8")).status;
		return typeof status === "string" && status ? status : state;
	} catch {
		return state;
	}
}
function send(config: string, args: readonly string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn(SENDER, args, {
			env: { ...process.env, TONY_FINISH_WEBHOOK_ENV: config },
			stdio: "ignore",
			detached: true,
		});
		const timer = setTimeout(() => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
				}
			}
			finish(`failed: sender exceeded ${timeoutMs}ms; acceptance unknown`);
		}, timeoutMs);
		const finish = (result: string) => {
			clearTimeout(timer);
			resolve(result);
		};
		child.once("error", () => finish("failed: sender could not start"));
		child.once("exit", (code, signal) =>
			finish(code === 0 ? "accepted: sender exited 0 (owner wake unobserved)" : `failed: sender ${signal ? "interrupted" : `exited ${code ?? "unknown"}`}`),
		);
	});
}
