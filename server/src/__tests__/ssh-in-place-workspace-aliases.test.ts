import { describe, expect, it } from "vitest";
import { normalizeEnvironmentConfig } from "../services/environment-config.ts";
import { resolveInPlaceAliasRoot } from "../services/workspace-realization.ts";

const aliases = [{ path: "/home/hermes/projects", target: "/home/stefan/projects" }];

describe("SSH in-place workspace aliases", () => {
  it("maps a Core path below an alias onto the host path", () => {
    expect(resolveInPlaceAliasRoot("/home/hermes/projects/homelab", aliases)).toBe("/home/stefan/projects/homelab");
    expect(resolveInPlaceAliasRoot("/home/hermes/projects", aliases)).toBe("/home/stefan/projects");
    expect(resolveInPlaceAliasRoot("/home/hermes/projects/a/../homelab/", aliases)).toBe("/home/stefan/projects/homelab");
  });

  it("leaves paths outside every alias in copy mode", () => {
    expect(resolveInPlaceAliasRoot("/home/hermes/projects-other/x", aliases)).toBeNull();
    expect(resolveInPlaceAliasRoot("/home/hermes/.paperclip/instances/default/workspaces/a", aliases)).toBeNull();
    expect(resolveInPlaceAliasRoot("relative/path", aliases)).toBeNull();
    expect(resolveInPlaceAliasRoot("/home/hermes/projects/homelab", [])).toBeNull();
    expect(resolveInPlaceAliasRoot("/home/hermes/projects/homelab", undefined)).toBeNull();
  });

  it("accepts and keeps the aliases in the stored SSH config", () => {
    const config = normalizeEnvironmentConfig({
      driver: "ssh",
      config: {
        host: "agents.example.test",
        username: "stefan",
        remoteWorkspacePath: "/home/stefan/projects",
        inPlaceWorkspaceAliases: aliases,
      },
    });
    expect(config).toMatchObject({ inPlaceWorkspaceAliases: aliases });
  });

  it("rejects relative alias paths", () => {
    expect(() => normalizeEnvironmentConfig({
      driver: "ssh",
      config: {
        host: "agents.example.test",
        username: "stefan",
        remoteWorkspacePath: "/home/stefan/projects",
        inPlaceWorkspaceAliases: [{ path: "home/hermes", target: "/home/stefan" }],
      },
    })).toThrow();
  });
});
