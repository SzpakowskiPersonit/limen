import { appendFile, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { promptCoordinator } from "../integrations/coordinator-wake.ts";
import { deliverFinishWebhook } from "../integrations/finish-webhook.ts";
import { settleJobTab } from "../integrations/herdr.ts";
import { commitList, headCommit } from "../project/git.ts";
import { processAlive, processInfo } from "../runtime/contain.ts";
import { jobMembership, saveJson, startGroupAdvance } from "./group-cabinet.ts";
import { syncLifecycle } from "./group-events.ts";
import { writeHandoff } from "./handoff.ts";
import { isTerminal, type TerminalState } from "./job.ts";

// The job record is a directory of plain files. `state` is the commit point observers key on;
// everything a reader needs must be durable before it flips to a terminal value.
export async function atomicWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${process.pid}.${Date.now().toString(16)}.tmp`;
	const handle = await open(temporary, "wx");
	try {
		await handle.writeFile(content);
		await handle.sync();
	} catch (error) {
		await handle.close();
		await rm(temporary, { force: true });
		throw error;
	}
	await handle.close();
	await rename(temporary, path);
}
export async function appendLimenLog(jobDir: string, message: string): Promise<void> {
	await appendFile(`${jobDir}/log`, `[limen ${new Date().toISOString()}] ${message}\n`);
}
export function isFailedStopReason(reason: string): boolean {
	return reason === "error" || reason.startsWith("error: ") || reason === "aborted" || reason.startsWith("aborted: ");
}
export const requestedTerminal = (reason: string): "done" | "stopped" =>
	reason.startsWith("done:") ? "done" : "stopped";
export async function finalizeJob(
	jobDir: string,
	state: TerminalState,
	detail: string,
	shutdownDeadline?: number,
): Promise<void> {
	if (isTerminal(await textFile(`${jobDir}/state`))) {
		return;
	}
	await recordCommits(jobDir).catch(() => {});
	await writeHandoff(jobDir, state, detail).catch((error) =>
		appendLimenLog(jobDir, `handoff write failed: ${error instanceof Error ? error.message : String(error)}`).catch(
			() => {},
		),
	);
	await atomicWrite(`${jobDir}/finished-at`, `${new Date().toISOString()}\n`);
	// The terminal log line lands before the state flip; state is the commit point observers key on, and the story must already be durable when they see it.
	const inbox = await readdir(`${jobDir}/steer/inbox`).catch(() => []);
	await appendLimenLog(
		jobDir,
		inbox.length ? `${state}: ${detail}; ${inbox.length} steer(s) never delivered` : `${state}: ${detail}`,
	).catch(() => {});
	await atomicWrite(`${jobDir}/state`, `${state}\n`);
	await rm(`${jobDir}/ownership-uncertainty`, { force: true });
	const group = await textFile(`${jobDir}/group`);
	if (group) {
		const membership = await jobMembership(jobDir);
		if (membership) {
			await syncLifecycle(membership.run, "skip").catch(() => {});
		}
		if (membership?.member?.role === "coordinator") {
			startGroupAdvance(membership.run);
		}
	}
	await rm(`${jobDir}/pid`, { force: true });
	await rm(`${jobDir}/born`, { force: true });
	// A tmp whose writer still runs is an in-flight rename by a racing finalizer, not a leftover; deleting it makes that rename ENOENT and crashes the other process.
	for (const name of await readdir(jobDir).catch(() => [])) {
		const writer = /\.(\d+)\.[0-9a-f]+\.tmp$/.exec(name);
		if (writer && !processAlive(Number(writer[1]))) {
			await rm(`${jobDir}/${name}`, { force: true });
		}
	}
	// The Herdr prompt is the coordinator's wake; the finish webhook is an opt-in side channel and never stands in for it.
	// Queuing the finish ping takes milliseconds; a detached deliverer sends it outside this shutdown grace. A group
	// member's wake decides there whether group events carry it.
	await Promise.all([
		promptCoordinator(jobDir, shutdownDeadline).catch(() =>
			appendLimenLog(jobDir, "coordinator wake via Herdr: could not be recorded; inspect notify/herdr-prompt").catch(
				() => {},
			),
		),
		deliverFinishWebhook(jobDir, detail).catch(() =>
			appendLimenLog(jobDir, "finish webhook: could not be queued; inspect finish-webhook-attempt").catch(() => {}),
		),
	]);
	await settleJobTab(jobDir);
}
export async function recordCommits(jobDir: string): Promise<void> {
	const [base, branch, worktree] = await Promise.all([
		textFile(`${jobDir}/base`),
		textFile(`${jobDir}/branch`),
		textFile(`${jobDir}/worktree`),
	]);
	if (!base || !branch || !worktree) {
		return;
	}
	const commits = commitList(worktree, base, branch);
	if (commits !== undefined) {
		await atomicWrite(`${jobDir}/commits`, commits ? `${commits}\n` : "");
	}
	await atomicWrite(`${jobDir}/tip`, `${headCommit(worktree)}\n`);
}
export async function textFile(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value.trim(),
		() => "",
	);
}
export async function writeHandshake(jobDir: string): Promise<void> {
	await atomicWrite(`${jobDir}/pid`, `${process.pid}\n`);
	void recordBorn(jobDir);
}
async function recordBorn(jobDir: string): Promise<void> {
	const outcome = await processInfo(process.pid);
	if (outcome.kind !== "present" || isTerminal(await textFile(`${jobDir}/state`))) {
		return;
	}
	await atomicWrite(`${jobDir}/born`, `${outcome.process.born}\n`);
	if (await textFile(`${jobDir}/group`)) {
		await saveJson(`${jobDir}/group-owner.json`, { pid: process.pid, born: outcome.process.born });
	}
}
