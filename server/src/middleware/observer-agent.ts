import type { RequestHandler } from "express";
import { isObserverAgent } from "../services/observer-agent-policy.js";

export const observerAgentBoundary: RequestHandler = (req, res, next) => {
  if (req.actor.type !== "agent" || !isObserverAgent(req.actor.agentId)) return next();
  // Runtime identity only: no unrelated tasks, connection discovery or MCP.
  if (req.method === "GET" && req.path === "/api/agents/me" && !req.url.includes("?")) return next();
  res.status(403).json({ error: "Use the observer capability broker", code: "observer_capability_boundary" });
};
