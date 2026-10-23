import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { onRemoteBranch } from "../project/git.ts";
import type { TerminalState } from "./job.ts";
import { appendLimenLog, atomicWrite, textFile } from "./record.ts";

/** `handoff.json`: the job's structured end. The finish webhook and the coordinator read it; the chat transcript is not the handoff. */
export type Handoff = {
	readonly status: TerminalState | "incomplete";
	readonly reason: string;
	readonly summary: string;
	readonly pr_url: string;
	readonly tests: readonly string[];
	readonly commits: number;
	readonly unpushed: boolean;
	readonly verdict: string;
	readonly follow_up: string;
};
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const TEST_LINE = /\b\d+\s+(?:tests?\s+)?(?:pass|passed|passing|fail|failed|failing)\b/i;
const VERDICT = /^(PASS|FAIL) ([0-9a-f]{7,40})\b/;

/** A done job that left `checkpoint.md` stopped at a budget checkpoint: its work continues, so it is incomplete, not done. */
export async function writeHandoff(jobDir: string, state: TerminalState, detail: string): Promise<Handoff> {
	const [result, commitText, branch, worktree, role] = await Promise.all([
		textFile(`${jobDir}/result`),
		textFile(`${jobDir}/commits`),
		textFile(`${jobDir}/branch`),
		textFile(`${jobDir}/worktree`),
		textFile(`${jobDir}/role`),
	]);
	const checkpoint = state === "done" && existsSync(`${jobDir}/checkpoint.md`);
	const commits = commitText ? commitText.split("\n").length : 0;
	const pr_url = PR_URL.exec(result)?.[0] ?? "";
	const unpushed = commits > 0 && !pr_url && Boolean(branch && worktree) && onRemoteBranch(worktree, branch) === false;
	const verdict = role === "reviewer" ? (VERDICT.exec(result)?.[0] ?? "") : "";
	const follow_up = verdict.startsWith("FAIL ") ? await fileFollowUp(jobDir, verdict, branch, result) : "";
	const reasons = [checkpoint ? "budget checkpoint: checkpoint.md present, work continues" : detail];
	if (unpushed) {
		reasons.push(`work only on job branch ${branch}: ${commits} commit(s), no remote branch and no PR`);
	}
	const handoff: Handoff = {
		status: checkpoint ? "incomplete" : state,
		reason: reasons.join("; "),
		summary: result.split("\n")[0] ?? "",
		pr_url,
		tests: result
			.split("\n")
			.filter((line) => TEST_LINE.test(line))
			.slice(0, 5),
		commits,
		unpushed,
		verdict,
		follow_up,
	};
	await atomicWrite(`${jobDir}/handoff.json`, `${JSON.stringify(handoff, null, 2)}\n`);
	if (unpushed) {
		await appendLimenLog(jobDir, `unpushed: ${handoff.reason}`);
	}
	return handoff;
}
/**
 * A review FAIL files one repair follow-up per failed head under `.limen/follow-ups/`. A second FAIL review of the
 * same head finds the file and adds none; the coordinator decides who repairs it.
 */
async function fileFollowUp(jobDir: string, verdict: string, branch: string, result: string): Promise<string> {
	const sha = verdict.split(" ")[1] ?? "";
	const path = join(resolve(jobDir, "../.."), "follow-ups", `${sha}.md`);
	await mkdir(join(path, ".."), { recursive: true });
	const body = `# Repair ${branch || "the candidate"} at ${sha}\n\nReview job ${basename(jobDir)} returned ${verdict}. Fix the blocking findings below, then request a fresh review.\n\n${result}\n`;
	try {
		await writeFile(path, body, { flag: "wx" });
		await appendLimenLog(jobDir, `review FAIL: filed follow-up ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
	return path;
}
