#!/usr/bin/env node
// check-layering.mjs — enforces the one architectural rule of the platform track:
//
//     Platform must never reference Product/Planner.
//
// Since S4 (the Gatherlight.Platform / Gatherlight.Planner assembly split) this is a compiler
// fact: Gatherlight.Platform.csproj carries no ProjectReference to Gatherlight.Planner, so a
// `using Gatherlight.Server.Product…` inside Platform is CS0234. The checks below are a fast
// redundancy over that — a build takes twenty seconds, this takes one — plus the one assertion
// that actually guarantees the rule structurally: that the ProjectReference itself never
// reappears. See docs/superpowers/specs/2026-08-04-site-model-container-design.md
//
// The namespace-reference check is a plain textual match, so a mention of the Product namespace
// inside a comment or string trips it too — deliberate: a checker that is too strict is safe, one
// that is too loose is not.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverDir = path.join(repo, 'src', 'server');
const platformRoot = path.join(serverDir, 'Gatherlight.Platform');
const plannerRoot = path.join(serverDir, 'Gatherlight.Planner');
const platformCsproj = path.join(platformRoot, 'Gatherlight.Platform.csproj');

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'obj' && e.name !== 'bin') walk(abs, out); }
    else if (e.name.endsWith('.cs')) out.push(abs);
  }
  return out;
};

// There is no more "unclassified module" branch (formerly: any leftover Modules/<name> folder).
// Classification is now the project boundary itself — a .cs file is Platform or Planner by which
// project root it lives under, so there is no third place for it to sit unclassified.
const errors = [];
const platformFiles = walk(platformRoot);
const plannerFiles = walk(plannerRoot);

if (platformFiles.length === 0 || plannerFiles.length === 0) {
  errors.push('no files under Gatherlight.Platform/ or Gatherlight.Planner/ — the assembly split has not run yet');
}

for (const abs of platformFiles) {
  const rel = path.relative(serverDir, abs).split(path.sep).join('/');
  const body = fs.readFileSync(abs, 'utf8');
  // A Platform file may not name the Product namespace root or any sub-namespace, in a using or
  // fully qualified.
  const hit = body.match(/\bGatherlight\.Server\.Product\b/);
  if (hit) errors.push(`${rel} references ${hit[0]} — Platform must never reference Product`);
}

// The structural assertion: the compiler only enforces the rule as long as this ProjectReference
// never reappears. Without this check, a re-added reference would quietly turn the rule back into
// a convention, and the namespace scan above would not catch it (Platform code needn't actually
// use a Planner type for the reference to compile).
// A missing csproj is a failure, not a skip: silently not running the assertion is exactly the
// hole it exists to close. Attribute order is not assumed (Condition= may precede Include=).
if (!fs.existsSync(platformCsproj)) {
  errors.push('Gatherlight.Platform.csproj not found — cannot assert the project reference graph');
} else {
  const csproj = fs.readFileSync(platformCsproj, 'utf8');
  if (/<ProjectReference[^>]*Gatherlight\.Planner\.csproj/.test(csproj)) {
    errors.push('Gatherlight.Platform.csproj has a ProjectReference to Gatherlight.Planner — Platform must never reference Planner');
  }
}

if (errors.length) {
  console.error('\x1b[31m✖ layering violations\x1b[0m');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`check-layering: clean — ${platformFiles.length} Platform files, ${plannerFiles.length} Planner files, Platform never references Planner.`);
process.exit(0);
