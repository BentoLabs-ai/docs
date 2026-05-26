#!/usr/bin/env node
// Validate skill.md against the Anthropic Agent Skills spec.
//
// Run with:  node .github/scripts/validate-skill.mjs skill.md
//
// Checks:
//   - File exists and has YAML frontmatter
//   - name: <=64 chars, lowercase letters / digits / hyphens only, not "claude" or "anthropic"
//   - description: non-empty, <=1024 chars, no XML tags
//   - body: <=500 lines (Anthropic best-practice guideline)
//   - body: at least one fenced code block (skills without examples rarely trigger)
//   - body: no obvious time-bombs ("after March 2025", "deprecated 2024" etc) outside <details>

import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] ?? "skill.md";
const abs = path.resolve(file);

if (!fs.existsSync(abs)) {
  fail(`File not found: ${abs}`);
}

const raw = fs.readFileSync(abs, "utf8");
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!fmMatch) {
  fail("Missing YAML frontmatter (--- ... ---) at the top of the file.");
}

const frontmatter = fmMatch[1];
const body = fmMatch[2];

const name = matchOne(frontmatter, /^name:\s*(.+)$/m);
const description = matchOne(frontmatter, /^description:\s*(.+(?:\n[ \t]+.+)*)$/m);

const problems = [];

// --- name checks ---
if (!name) {
  problems.push("frontmatter `name` is required");
} else {
  if (name.length > 64) problems.push(`name length ${name.length} > 64`);
  if (!/^[a-z0-9-]+$/.test(name)) problems.push(`name "${name}" must match ^[a-z0-9-]+$`);
  if (name.includes("claude") || name.includes("anthropic")) {
    problems.push(`name "${name}" cannot contain reserved words "claude" or "anthropic"`);
  }
}

// --- description checks ---
if (!description) {
  problems.push("frontmatter `description` is required");
} else {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length === 0) problems.push("description is empty");
  if (flat.length > 1024) problems.push(`description length ${flat.length} > 1024`);
  if (/<[a-zA-Z][^>]*>/.test(flat)) problems.push("description must not contain XML tags");
}

// --- body checks ---
const lineCount = body.split("\n").length;
if (lineCount > 500) {
  problems.push(`body is ${lineCount} lines > 500 (split into supporting files)`);
}

const codeBlocks = (body.match(/^```/gm) ?? []).length / 2;
if (codeBlocks < 1) {
  problems.push("body contains no fenced code blocks; skills without examples rarely trigger");
}

// time-bomb sniffer (outside <details> blocks)
const detailsStripped = body.replace(/<details>[\s\S]*?<\/details>/g, "");
const yearRegex = /\b(?:before|after|until|deprecated)\s+\w+\s+(20\d{2})\b/gi;
const timeBombs = detailsStripped.match(yearRegex) ?? [];
if (timeBombs.length > 0) {
  problems.push(
    `body contains time-bound phrases outside <details>: ${timeBombs.slice(0, 3).join(", ")}`,
  );
}

// --- report ---
console.log(`name: ${name}`);
console.log(`description length: ${description ? description.replace(/\s+/g, " ").trim().length : 0} / 1024 chars`);
console.log(`body lines: ${lineCount} / 500`);
console.log(`body fenced code blocks: ${codeBlocks}`);

if (problems.length > 0) {
  console.error("");
  console.error("skill.md validation failed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log("");
console.log("skill.md is valid");
process.exit(0);

function matchOne(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : null;
}

function fail(msg) {
  console.error(`skill.md validation failed: ${msg}`);
  process.exit(1);
}
