import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const afterInstall = readFileSync("after-install.md", "utf8");

const expectedInstall =
  "openclaw plugins install git:github.com/OnchainRouter/onchain-router-openclaw@v0.2.1 --force";

if (packageJson.name !== "@onchainrouter/openclaw") {
  throw new Error("public package name drifted");
}
if (packageJson.version !== "0.2.1" || packageJson.openclaw?.compat?.pluginApi !== ">=2026.8.1") {
  throw new Error("release or OpenClaw compatibility metadata drifted");
}
if (packageJson.openclaw?.runtimeExtensions?.[0] !== "./dist/index.js") {
  throw new Error("built runtime entry is missing");
}
if (
  packageJson.openclaw?.extensions?.[0] !== "./dist/index.js" ||
  packageJson.peerDependenciesMeta?.openclaw?.optional !== true
) {
  throw new Error("native Git runtime or optional host peer metadata drifted");
}
if (!packageJson.files?.includes("after-install.md")) {
  throw new Error("post-install guide is missing from the package");
}
if (packageJson.scripts?.["qualification:git-install"] !== "node scripts/git-install.mjs") {
  throw new Error("native Git install qualification is missing");
}
if (!readme.includes(expectedInstall) || !readme.includes("openclaw plugins inspect onchain-router")) {
  throw new Error("README does not contain the pinned host-native install and verification path");
}
if (/not yet published|source candidate/i.test(readme)) {
  throw new Error("README still claims the public release is unavailable");
}
if (!afterInstall.includes("does not create, import, unlock, or fund a wallet")) {
  throw new Error("post-install wallet boundary is missing");
}

console.log("openclaw_distribution_metadata_ok");
