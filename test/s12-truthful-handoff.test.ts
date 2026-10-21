// S12 · Truthful handoff. A job's end is `handoff.json`, not its last chat message: a late background notice never
// replaces the first handoff, a budget checkpoint ends incomplete, work left only on the job branch is named, and a
// review FAIL files exactly one repair follow-up per failed head.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { git, jobFile, plant, requests, spawnJob, until, waitJob } from "./plant.ts";

const p = await plant();
after(p.cleanup);
const URL = "https://hooks.s12.test/one";
await writeFile(
	join(p.root, ".limen/finish-webhook.env"),
	`LIMEN_FINISH_WEBHOOK_URL='${URL}'\nLIMEN_FINISH_WEBHOOK_AUTH='Bearer s12-secret'\n`,
);
const handoff = (id: string) => JSON.parse(jobFile(p, id, "handoff.json"));
const ping = async (id: string) => {
	await until(p.parent, () => /^(accepted|failed)/.test(jobFile(p, id, "finish-webhook")));
	const body = requests(p)
		.map((request) => JSON.parse(request.body))
		.find((entry) => entry.jobId === id);
	assert.ok(body, `no ping for ${id}`);
	return body;
};

test("a late background notice after the handoff never replaces the result or the webhook reason", async () => {
	const id = spawnJob(
		p,
		"say Handoff: PR https://github.com/o/r/pull/7, 12 tests passed\nlate This late result changes nothing",
	);
	assert.equal(waitJob(p, id), "done");
	assert.equal(jobFile(p, id, "result"), "Handoff: PR https://github.com/o/r/pull/7, 12 tests passed");
	assert.equal(jobFile(p, id, "result-late"), "This late result changes nothing");
	const written = handoff(id);
	assert.equal(written.status, "done");
	assert.equal(written.pr_url, "https://github.com/o/r/pull/7");
	assert.deepEqual(written.tests, ["Handoff: PR https://github.com/o/r/pull/7, 12 tests passed"]);
	const body = await ping(id);
	assert.match(body.reason, /^Handoff: PR/);
	assert.equal(body.prUrl, "https://github.com/o/r/pull/7");
});

test("a job that ends at a budget checkpoint is incomplete with a reason, not done", async () => {
	const id = spawnJob(p, "checkpoint\nsay I stopped at the 80% budget signal");
	assert.equal(waitJob(p, id), "done");
	const written = handoff(id);
	assert.equal(written.status, "incomplete");
	assert.match(written.reason, /budget checkpoint/);
	const body = await ping(id);
	assert.equal(body.event, "job.incomplete");
	assert.equal(body.status, "incomplete");
	assert.equal(body.jobState, undefined);
	assert.match(body.reason, /budget checkpoint/);
	assert.match(body.handoff, /not finished/);
});

test("commits left only on the job branch, with a remote and no PR, are named in the handoff", async () => {
	const remote = join(p.parent, "remote.git");
	git(p.parent, "init", "-q", "--bare", remote);
	git(p.root, "remote", "add", "origin", remote);
	git(p.root, "push", "-q", "origin", "main");
	const id = spawnJob(p, "commit\nsay committed locally");
	assert.equal(waitJob(p, id), "done");
	const written = handoff(id);
	assert.equal(written.unpushed, true);
	assert.equal(written.commits, 1);
	assert.match(written.reason, /work only on job branch limen\/.+: 1 commit\(s\), no remote branch and no PR/);
	assert.match((await ping(id)).reason, /work only on job branch/);
	git(p.root, "push", "-q", "origin", jobFile(p, id, "branch"));
	const pushed = spawnJob(p, "say nothing new");
	assert.equal(waitJob(p, pushed), "done");
	assert.equal(handoff(pushed).unpushed, false);
});

test("a review FAIL files one repair follow-up per failed head, and a second FAIL of that head adds none", async () => {
	const worker = spawnJob(p, "commit\nsay candidate ready");
	assert.equal(waitJob(p, worker), "done");
	const branch = jobFile(p, worker, "branch");
	const sha = git(p.root, "rev-parse", branch).trim();
	const review = () => spawnJob(p, `say FAIL ${sha}\nblocking: the scenario breaks`, ["--review", "--branch", branch]);
	const first = review();
	assert.equal(waitJob(p, first), "done");
	const second = review();
	assert.equal(waitJob(p, second), "done");
	const followUps = join(p.root, ".limen/follow-ups");
	assert.deepEqual(readdirSync(followUps), [`${sha}.md`]);
	assert.match(
		readFileSync(join(followUps, `${sha}.md`), "utf8"),
		new RegExp(`Review job ${first} returned FAIL ${sha}`),
	);
	assert.equal(handoff(second).follow_up, join(followUps, `${sha}.md`));
	assert.match(jobFile(p, first, "log"), /review FAIL: filed follow-up/);
	assert.doesNotMatch(jobFile(p, second, "log"), /review FAIL: filed follow-up/);
	const body = await ping(first);
	assert.equal(body.event, "job.review-failed");
	assert.match(body.handoff, /follow-up/);
	const pass = spawnJob(p, `say PASS ${sha}`, ["--review", "--branch", branch]);
	assert.equal(waitJob(p, pass), "done");
	assert.equal(handoff(pass).follow_up, "");
	assert.equal(existsSync(join(followUps, `${sha}.md`)), true);
});
