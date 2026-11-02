import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observerAgentBoundary } from "./observer-agent.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

afterEach(() => vi.unstubAllEnvs());
describe("observer capability boundary", () => {
  function app(agentId = "observer", source = "agent_jwt") {
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "agent", agentId, companyId: "company", source } as typeof req.actor; next(); });
    app.use(observerAgentBoundary);
    app.use((_req,res) => res.json({ reachedRoute: true }));
    return app;
  }
  it("denies REST and callback-tunnel authority for both run JWTs and agent keys", async () => {
    vi.stubEnv("PAPERCLIP_OBSERVER_AGENT_IDS","observer");
    for (const source of ["agent_jwt","agent_key"]) {
      for (const path of ["/api/companies/company/issues", "/api/agents/me/secrets/admin/value", "/api/mcp", "/api/agents/ceo/wakeup"]) {
        expect((await request(app("observer",source)).post(path).send({})).status).toBe(403);
      }
      expect((await request(app("observer",source)).get("/api/issues/private")).status).toBe(403);
      expect((await request(app("observer",source)).get("/api/agents/me")).status).toBe(200);
    }
  });
  it("does not affect ordinary agents or a deployment without observers", async () => {
    vi.stubEnv("PAPERCLIP_OBSERVER_AGENT_IDS","observer");
    expect((await request(app("ceo")).post("/api/companies/company/issues")).status).toBe(200);
    vi.stubEnv("PAPERCLIP_OBSERVER_AGENT_IDS","");
    expect((await request(app()).get("/api/issues/private")).status).toBe(200);
  });
  it("also denies native semantic actions even when their names are guessed", async () => {
    vi.stubEnv("PAPERCLIP_OBSERVER_AGENT_IDS","observer");
    const authority = new PaperclipRunnerToolAuthority(null as never, { agentId: "observer" } as never);
    expect(authority.definitions()).toEqual([]);
    for (const tool of ["create_task","reassign_task","call_api","read_document","search_connections"]) {
      await expect(authority.execute({ tool, callId:"attempt", arguments:{} })).rejects.toThrow("capability broker");
    }
  });
});
