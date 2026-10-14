import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializePublishManifest, readReleaseWorkspaceVersions } from "./prepare-bundled-package.mjs";

test("different workspace versions pack and install together offline with consumer hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-workspace-version-install-"));
  try {
    const sdk = join(root, "sdk");
    const consumer = join(root, "consumer");
    mkdirSync(sdk); mkdirSync(consumer); mkdirSync(join(root, "scripts"));
    const sdkManifest = { name: "paperclip-fixture-sdk", version: "1.0.0", main: "index.cjs", files: ["index.cjs"] };
    const consumerManifest = { name: "paperclip-fixture-consumer", version: "0.3.1", main: "index.cjs",
      files: ["index.cjs", "hook.cjs"], dependencies: { [sdkManifest.name]: "workspace:*" },
      scripts: { postinstall: "node hook.cjs" } };
    writeFileSync(join(sdk, "package.json"), JSON.stringify(sdkManifest));
    writeFileSync(join(consumer, "package.json"), JSON.stringify(consumerManifest));
    writeFileSync(join(root, "scripts/release-package-manifest.json"), JSON.stringify([
      { dir: "sdk", name: sdkManifest.name }, { dir: "consumer", name: consumerManifest.name },
    ]));
    const versions = readReleaseWorkspaceVersions(root);
    writeFileSync(join(consumer, "package.json"), JSON.stringify(materializePublishManifest(consumerManifest, versions)));
    writeFileSync(join(sdk, "index.cjs"), "module.exports = 'sdk-1.0.0';");
    writeFileSync(join(consumer, "index.cjs"), "module.exports = require('paperclip-fixture-sdk');");
    writeFileSync(join(consumer, "hook.cjs"), "require('node:fs').writeFileSync('consumer-hook-ran', 'yes');");
    const userConfig = join(root, "user.npmrc"); const globalConfig = join(root, "global.npmrc");
    writeFileSync(userConfig, ""); writeFileSync(globalConfig, "");
    const env = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(root, "npm-cache"), NPM_CONFIG_OFFLINE: "true" };
    const npm = (args, cwd) => execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: 30_000 });
    const sdkTar = npm(["pack", "--ignore-scripts", "--silent", "--pack-destination", root], sdk).trim();
    const consumerTar = npm(["pack", "--ignore-scripts", "--silent", "--pack-destination", root], consumer).trim();
    const prefix = join(root, "installed");
    npm(["install", "--prefix", prefix, join(root, sdkTar), join(root, consumerTar), "--no-audit", "--no-fund"], root);
    const installed = join(prefix, "node_modules/paperclip-fixture-consumer");
    assert.equal(readFileSync(join(installed, "consumer-hook-ran"), "utf8"), "yes");
    assert.equal(execFileSync(process.execPath, ["-p", "require('./node_modules/paperclip-fixture-consumer')"],
      { cwd: prefix, encoding: "utf8", timeout: 10_000 }).trim(), "sdk-1.0.0");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.dependencies[sdkManifest.name], "1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
