// S12 · A job's end is `handoff.json`, not its last chat message; a review FAIL files one follow-up per failed head.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { git, jobFile, plant, requests, spawnJob, until, waitJob } from "./plant.ts";

const p = await plant();
after(p.cleanup);
await writeFile(
	join(p.root, ".limen/finish-webhook.env"),
	"LIMEN_FINISH_WEBHOOK_URL='https://hooks.s12.test/one'\nLIMEN_FINISH_WEBHOOK_AUTH='Bearer s12-secret'\n",
);
const done = (task: string, flags: string[] = []) => {
	const id = spawnJob(p, task, flags);
	assert.equal(waitJob(p, id), "done");
	return id;
};
const handoff = (id: string) => JSON.parse(jobFile(p, id, "handoff.json"));
const ping = async (id: string) => {
	await until(p.parent, () => /^(accepted|failed)/.test(jobFile(p, id, "finish-webhook")));
	return requests(p)
		.map((request) => JSON.parse(request.body))
		.find((entry) => entry.jobId === id);
};

test("a late notice never replaces the handoff; a budget checkpoint ends incomplete, not done", async () => {
	const pr = "https://github.com/o/r/pull/7";
	const id = done(`say Handoff: PR ${pr}, 12 tests passed\nlate This late result changes nothing`);
	assert.equal(jobFile(p, id, "result"), `Handoff: PR ${pr}, 12 tests passed`);
	assert.equal(jobFile(p, id, "result-late"), "This late result changes nothing");
	const { status, pr_url, tests } = handoff(id);
	assert.deepEqual(
		{ status, pr_url, tests },
		{ status: "done", pr_url: pr, tests: [`Handoff: PR ${pr}, 12 tests passed`] },
	);
	const body = await ping(id);
	assert.deepEqual([body.reason.startsWith("Handoff: PR"), body.prUrl], [true, pr]);
	const stopped = done("checkpoint\nsay I stopped at the 80% budget signal");
	assert.equal(handoff(stopped).status, "incomplete");
	const late = await ping(stopped);
	assert.deepEqual([late.event, late.status, late.jobState], ["job.incomplete", "incomplete", undefined]);
	assert.match(
		`${handoff(stopped).reason} ${late.reason} ${late.handoff}`,
		/budget checkpoint.*budget checkpoint.*not finished/s,
	);
});

test("commits left only on the job branch, with a remote and no PR, are named in the handoff", async () => {
	git(p.parent, "init", "-q", "--bare", join(p.parent, "remote.git"));
	git(p.root, "remote", "add", "origin", join(p.parent, "remote.git"));
	git(p.root, "push", "-q", "origin", "main");
	const id = done("commit\nsay committed locally");
	assert.deepEqual([handoff(id).unpushed, handoff(id).commits], [true, 1]);
	assert.match(handoff(id).reason, /work only on job branch limen\/.+: 1 commit\(s\), no remote branch and no PR/);
	assert.match((await ping(id)).reason, /work only on job branch/);
	git(p.root, "push", "-q", "origin", jobFile(p, id, "branch"));
	assert.equal(handoff(done("say nothing new")).unpushed, false);
});

test("a review FAIL files one repair follow-up per failed head, and a second FAIL of that head adds none", async () => {
	const branch = jobFile(p, done("commit\nsay candidate ready"), "branch");
	const sha = git(p.root, "rev-parse", branch).trim();
	const review = () => done(`say FAIL ${sha}\nblocking: it breaks`, ["--review", "--branch", branch]);
	const [first, second] = [review(), review()];
	const followUp = join(p.root, ".limen/follow-ups", `${sha}.md`);
	assert.deepEqual(readdirSync(join(p.root, ".limen/follow-ups")), [`${sha}.md`]);
	assert.match(readFileSync(followUp, "utf8"), new RegExp(`Review job ${first} returned FAIL ${sha}`));
	assert.equal(handoff(second).follow_up, followUp);
	assert.match(jobFile(p, first, "log"), /review FAIL: filed follow-up/);
	assert.doesNotMatch(jobFile(p, second, "log"), /review FAIL: filed follow-up/);
	const body = await ping(first);
	assert.deepEqual([body.event, /follow-up/.test(body.handoff)], ["job.review-failed", true]);
	assert.equal(handoff(done(`say PASS ${sha}`, ["--review", "--branch", branch])).follow_up, "");
	assert.equal(existsSync(followUp), true);
});
