import { describe, expect, it } from "vitest";
import { parseKubernetesProviderConfig } from "../../src/types.js";

describe("persistent home configuration", () => {
  it("is opt-in and cannot silently fall back to an ephemeral Job", () => {
    expect(parseKubernetesProviderConfig({ inCluster:true }).homePersistentVolumeClaim).toBeUndefined();
    expect(parseKubernetesProviderConfig({ inCluster:true,homePersistentVolumeClaim:"communication-home" })
      .homePersistentVolumeClaim).toBe("communication-home");
    expect(() => parseKubernetesProviderConfig({ inCluster:true,backend:"job",homePersistentVolumeClaim:"communication-home" })).toThrow();
    for (const name of ["../foreign", "/var/lib/host", "OtherNamespace/claim", ""]) {
      expect(() => parseKubernetesProviderConfig({ inCluster:true,homePersistentVolumeClaim:name })).toThrow();
    }
  });
  it("supports fixed operator host aliases without broad DNS access", () => {
    const hostAliases = [{ ip: "100.101.48.108", hostnames: ["agent-services.tailea77a9.ts.net"] }];
    expect(parseKubernetesProviderConfig({ inCluster: true, hostAliases }).hostAliases).toEqual(hostAliases);
    expect(() => parseKubernetesProviderConfig({ inCluster: true,
      hostAliases: [{ ip: "not-an-ip", hostnames: ["broker"] }] })).toThrow();
  });
});
