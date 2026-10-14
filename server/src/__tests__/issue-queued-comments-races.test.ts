import { recordNativeAcceptedCommentInputs } from "../services/native-runtime/native-comment-input-receipts.js";
import { recordAcceptedCommentInputs } from "../services/comment-input-receipts.js";
import { spawn, type ChildProcess } from "node:child_process";
import { runningProcesses } from "../adapters/index.js";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  activityLog,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueThreadInteractions,
  issueRecoveryActions,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { initializeRunIdentity, reconcileSteeredIdentity } from "../services/run-identity.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const steerNativeSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  steerNativeSessionMock.mockImplementation(actual.steerNativeSession);
  return { ...actual, steerNativeSession: steerNativeSessionMock };
});
const { NativeSessionSteeringError } = await import("../services/native-runtime/native-session-executor.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-comment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue queued-comment routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comments-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  const testProcesses = new Map<string, ChildProcess>();

  afterEach(async () => {
    for (const [id, child] of testProcesses) {
      runningProcesses.delete(id);
      child.kill();
    }
    testProcesses.clear();
    // Each case owns the entire disposable database. Clear the full company
    // graph, including attribution rows and constraints added by migrations.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, userId = "queue-owner", agentActor?: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: agentActor ? "agent" : "board",
        ...(agentActor ? { ...agentActor, companyId } : {}),
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const commentIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Test Company",
      issuePrefix: "QUE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paperclip Runner",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: "queue-owner",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: "other-operator",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "issue_comment",
      reason: "Follow-up comments arrived during the active run",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "queue-owner",
      payload: {
        issueId,
        commentId: commentIds[1],
        _paperclipWakeContext: {
          commentId: commentIds[1],
          wakeCommentId: commentIds[1],
          wakeCommentIds: commentIds,
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "queue route test",
      status: "running",
      runtimeMode: "native",
      startedAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "QUE-1",
      title: "Queued steering",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });
    await db.insert(issueComments).values(commentIds.map((id, index) => ({
      id,
      companyId,
      issueId,
      authorType: "user" as const,
      authorUserId: "queue-owner",
      body: index === 0 ? "First queued message" : "Second queued message",
      createdAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
      updatedAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
    })));
    return { companyId, agentId, issueId, runId, wakeId, commentIds };
  }

  it("QA-STE245 rejects receipts outside the offered snapshot and foreign run scope", async () => {
    const seeded = await seedQueue();
    const comments = await db.select().from(issueComments);
    const offered = comments.map(c => ({ id: c.id, updatedAt: c.updatedAt.toISOString() }));
    expect(await recordAcceptedCommentInputs(db, { ...seeded, offered, accepted: [{...offered[0], updatedAt: new Date().toISOString()}] })).toEqual([]);
    expect(await recordAcceptedCommentInputs(db, { ...seeded, companyId: randomUUID(), offered, accepted: offered })).toEqual([]);
    expect(await recordAcceptedCommentInputs(db, { ...seeded, agentId: randomUUID(), offered, accepted: offered })).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0].contextSnapshot).not.toHaveProperty("acceptedCommentInputs");
    expect((await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`)).body.entries).toHaveLength(2);
  });

  it("QA-STE245 concurrent selections and old retry retain both revisions", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({ adapterType: "codex_local", status: "paused" }).where(eq(agents.id, seeded.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "queued", startedAt: null }).where(eq(heartbeatRuns.id, seeded.runId));
    const client = app(seeded.companyId);
    const queue = (await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`)).body;
    const inputs = queue.entries.map((e: any) => ({ id:e.comment.id, updatedAt:e.comment.updatedAt }));
    const send = (input: any) => request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`)
      .send({ queueId:seeded.wakeId, revision:queue.revision, targetRunId:seeded.runId, inputs:[input] }).expect(200);
    await Promise.all(inputs.map(send));
    await send(inputs[0]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,seeded.wakeId));
    expect(wake.payload?.queuedCommentInterrupt.inputs).toEqual(inputs);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("keeps unversioned historical intent visible and requires a verifiable selection", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({adapterType:"codex_local"}).where(eq(agents.id,seeded.agentId));
    await db.update(heartbeatRuns).set({runtimeMode:"legacy"}).where(eq(heartbeatRuns.id,seeded.runId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,seeded.wakeId));
    await db.update(agentWakeupRequests).set({payload:{...wake.payload,queuedCommentInterrupt:{actorId:"queue-owner",actorSource:"session",targetRunId:seeded.runId,requestedAt:new Date().toISOString()}}}).where(eq(agentWakeupRequests.id,seeded.wakeId));
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId,seeded.wakeId);
    const queue=(await request(app(seeded.companyId)).get(`/api/issues/${seeded.issueId}/queued-comments`)).body;
    expect(queue.entries).toHaveLength(2);
    expect(queue.interruptRequestedAt).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,seeded.runId)))[0].status).toBe("running");
  });

  it("QA-STE245 revoked operator cannot stop a run through old saved intent", async () => {
    const seeded = await seedQueue();
    await db.update(agents).set({adapterType:"codex_local", runtimeConfig:{heartbeat:{maxConcurrentRuns:1}}}).where(eq(agents.id,seeded.agentId));
    await db.update(heartbeatRuns).set({runtimeMode:"legacy",status:"queued",startedAt:null}).where(eq(heartbeatRuns.id,seeded.runId));
    const client = app(seeded.companyId);
    const queue = (await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`)).body;
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({queueId:seeded.wakeId,revision:queue.revision,targetRunId:seeded.runId}).expect(200);
    await db.update(companyMemberships).set({membershipRole:"viewer"}).where(eq(companyMemberships.principalId,"queue-owner"));
    const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
    testProcesses.set(seeded.runId,child); runningProcesses.set(seeded.runId,{child,graceSec:1,processGroupId:null});
    await db.update(heartbeatRuns).set({status:"running",startedAt:new Date()}).where(eq(heartbeatRuns.id,seeded.runId));
    const capacityId=randomUUID();
    await db.insert(heartbeatRuns).values({id:capacityId,companyId:seeded.companyId,agentId:seeded.agentId,status:"running",contextSnapshot:{issueId:randomUUID()}});
    await heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId,seeded.wakeId);
    const runs=await db.select().from(heartbeatRuns);
    console.log("QA_REVOKED_OPERATOR",JSON.stringify({target:runs.find(r=>r.id===seeded.runId)?.status,successors:runs.filter(r=>r.status==='queued').length}));
    expect(runs.find(r=>r.id===seeded.runId)?.status).toBe("running");
  });

  it.each(["receipt", "edit", "pause", "partial-edit", "revoke"] as const)("QA-STE245 rechecks %s changed after stop claim before admission", async change => {
    const seeded=await seedQueue();
    await db.update(agents).set({adapterType:"codex_local",runtimeConfig:{heartbeat:{maxConcurrentRuns:1}}}).where(eq(agents.id,seeded.agentId));
    await db.update(heartbeatRuns).set({runtimeMode:"legacy",status:"queued",startedAt:null}).where(eq(heartbeatRuns.id,seeded.runId));
    const client=app(seeded.companyId);
    const queue=(await request(client).get(`/api/issues/${seeded.issueId}/queued-comments`)).body;
    await request(client).post(`/api/issues/${seeded.issueId}/queued-comments/interrupt`).send({queueId:seeded.wakeId,revision:queue.revision,targetRunId:seeded.runId}).expect(200);
    const child=spawn(process.execPath,["-e",`for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{process.send('stopping');setTimeout(()=>process.exit(0),8000)});process.on('message',()=>process.exit(0));setInterval(()=>{},1000);process.send('ready')`],{stdio:["ignore","ignore","ignore","ipc"]});
    testProcesses.set(seeded.runId,child); runningProcesses.set(seeded.runId,{child,graceSec:10,processGroupId:null});
    const ready=await new Promise(resolve=>child.once("message",resolve)); expect(ready).toBe("ready");
    await db.update(heartbeatRuns).set({status:"running",startedAt:new Date()}).where(eq(heartbeatRuns.id,seeded.runId));
    const capacityId=randomUUID();
    await db.insert(heartbeatRuns).values({id:capacityId,companyId:seeded.companyId,agentId:seeded.agentId,status:"running",contextSnapshot:{issueId:randomUUID()}});
    const stopSignal=new Promise(resolve=>child.once("message",resolve));
    const resume=heartbeatService(db).resumeQueuedCommentInterrupt(seeded.companyId,seeded.wakeId);
    try {
      expect(await stopSignal).toBe("stopping");
      if(change==='receipt') {
        const offered=queue.entries.map((e:any)=>({id:e.comment.id,updatedAt:e.comment.updatedAt}));
        await recordAcceptedCommentInputs(db,{...seeded,offered,accepted:offered});
      } else if(change==='pause') {
        await db.update(agents).set({status:"paused"}).where(eq(agents.id,seeded.agentId));
      } else if(change==='revoke') {
        await db.update(companyMemberships).set({membershipRole:"viewer"}).where(eq(companyMemberships.principalId,"queue-owner"));
      } else if(change==='edit') {
        await db.update(issueComments).set({body:"changed after stop claim",updatedAt:new Date()}).where(eq(issueComments.issueId,seeded.issueId));
      } else {
        await db.update(issueComments).set({body:"changed after stop claim",updatedAt:new Date()}).where(eq(issueComments.id,seeded.commentIds[1]));
      }
    } finally {child.send("exit");}
    const stopError=await resume.then(()=>null,(error:any)=>({message:error.message,status:error.status}));
    if(change!=="pause") expect(stopError).toBeNull();
    else if(stopError) expect(stopError.status).toBe(409);
    const runs=await db.select().from(heartbeatRuns);
    const next=runs.filter(r=>r.id!==seeded.runId&&r.id!==capacityId);
    const [savedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,seeded.wakeId));
    let resumedWakeStatus: string|null=null;
    if(change==='pause') {
      await db.update(agents).set({status:"idle"}).where(eq(agents.id,seeded.agentId));
      await db.update(agentWakeupRequests).set({updatedAt:new Date(0)}).where(eq(agentWakeupRequests.id,seeded.wakeId));
      await heartbeatService(db).resumeQueuedRuns();
      await heartbeatService(db).resumeQueuedRuns();
      const resumed = (await db.select().from(heartbeatRuns)).filter(run => run.id !== seeded.runId && run.id !== capacityId);
      expect(resumed).toHaveLength(1);
      expect(resumed[0].contextSnapshot?.wakeCommentIds).toEqual(seeded.commentIds);
      resumedWakeStatus=(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,seeded.wakeId)))[0].status;
    }
    console.log("QA_STOP_RACE",JSON.stringify({change,stopError,selectedIds:seeded.commentIds,wakeStatus:savedWake.status,wakeRunId:savedWake.runId,resumedWakeStatus,successors:next.map(r=>({id:r.id,status:r.status,context:r.contextSnapshot}))}));
    if (change==='pause') expect(savedWake.status).toBe("deferred_issue_execution");
    if(change==='partial-edit') {
      expect(next).toHaveLength(1);
      expect(next[0].contextSnapshot?.wakeCommentIds).toEqual([seeded.commentIds[0]]);
      expect(savedWake.status).toBe("deferred_issue_execution");
      expect(savedWake.payload?._paperclipWakeContext.wakeCommentIds).toEqual([seeded.commentIds[1]]);
    } else expect(next).toHaveLength(0);
  },30_000);

  it("native receipt requires provider evidence and retains the offered revision across edits", async () => {
    const seeded = await seedQueue();
    const comments = await db.select().from(issueComments);
    const offered = comments.map(comment => ({ id: comment.id, updatedAt: comment.updatedAt.toISOString() }));
    await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeExecutionInput: { provider: { kind: "codex" }, task: {prompt:"Exact initial input"} }, nativeCommentInputs: {bootstrap:offered,continuation:[],bootstrapPromptSha256:createHash("sha256").update("Exact initial input").digest("hex"),continuationPromptSha256:null},
    } }).where(eq(heartbeatRuns.id, seeded.runId));
    expect(await recordNativeAcceptedCommentInputs(db, seeded, {eventType:"turn.submitted", turnId:"turn-a"})).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,seeded.runId)))[0].contextSnapshot).not.toHaveProperty("acceptedCommentInputs");
    await db.update(issueComments).set({body:"edited during dispatch", updatedAt:new Date(Date.now()+1000)}).where(eq(issueComments.id,offered[1].id));
    const acceptance = {eventType:"turn.accepted",turnId:"turn-a",sourceInstanceId:"fixture-provider",sourceSeq:2};
    // An accepted status alone, without the actual submitted text, is insufficient.
    expect(await recordNativeAcceptedCommentInputs(db, seeded, acceptance)).toEqual([]);
    const submission = {eventType:"turn.submitted",payload:{text:JSON.stringify({schema:"paperclip.native-model-envelope.v3",task:{prompt:"Exact initial input"}})}};
    await db.insert(heartbeatRunEvents).values([submission,acceptance].map((event,index)=>({
      companyId:seeded.companyId,agentId:seeded.agentId,runId:seeded.runId,seq:index+1,
      sourceInstanceId:"fixture-provider",sourceSeq:index+1,eventType:event.eventType,payload:{prpEvent:event},
    })));
    expect(await recordNativeAcceptedCommentInputs(db, seeded, {...acceptance,turnId:"unrelated-turn"})).toEqual([]);
    await recordNativeAcceptedCommentInputs(db, seeded, acceptance);
    await recordNativeAcceptedCommentInputs(db, seeded, acceptance);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,seeded.runId));
    expect(run.contextSnapshot?.acceptedCommentInputs).toEqual(offered);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,seeded.wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
    expect(wake.payload?._paperclipWakeContext.wakeCommentIds).toEqual([offered[1].id]);
  });

});
