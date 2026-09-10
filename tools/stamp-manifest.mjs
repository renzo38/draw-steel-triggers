#!/usr/bin/env node
/**
 * Rewrite module.json for a release.
 *
 * Foundry installs a module by fetching the `manifest` URL, reading `version`
 * and `download` from it, then unpacking that zip. Those three fields therefore
 * have to agree with the tag being published, and a mismatch is the usual
 * reason an install silently fetches the wrong build.
 *
 * `manifest` deliberately points at `releases/latest/download/module.json`
 * rather than at this tag: that is the URL users paste once and keep, and it is
 * what lets Foundry notice later updates. `download` points at this exact tag,
 * so an install never races a release published moments later.
 *
 * Usage: node tools/stamp-manifest.mjs <version> <owner/repo>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , rawVersion, repo] = process.argv;

if (!rawVersion || !repo) {
  console.error("usage: node tools/stamp-manifest.mjs <version> <owner/repo>");
  process.exit(1);
}

const version = rawVersion.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`version « ${version} » invalide : attendu MAJEUR.MINEUR.CORRECTIF`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("module.json", "utf8"));

manifest.version = version;
manifest.url = `https://github.com/${repo}`;
manifest.manifest = `https://github.com/${repo}/releases/latest/download/module.json`;
manifest.download = `https://github.com/${repo}/releases/download/v${version}/module.zip`;

writeFileSync("module.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`module.json estampillé en ${version} pour ${repo}`);
