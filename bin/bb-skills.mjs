#!/usr/bin/env node
/**
 * bb-skills — install/verify the Backbencher Brain agent skills.
 *
 * The package ships one directory per skill (`skills/<name>/SKILL.md`) and this
 * installer copies those directories into a host's skills directory, writing a
 * manifest so a re-run is idempotent and never touches directories it did not create.
 *
 * Hosts (project scope by default):
 *   claude  -> <cwd>/.claude/skills
 *   agents  -> <cwd>/.agents/skills
 *   copilot -> <cwd>/.github/skills
 *   user-claude -> ~/.claude/skills
 *   --dir <path> -> any directory the caller names
 *
 * Plain ESM, no dependencies, Node >= 18.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const SRC = join(ROOT, "skills")
const MANIFEST = ".bb-skills.json"

function pkg() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
}
function skillNames() {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SRC, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort()
}
function usage(exitCode = 0) {
  const text = `bb-skills ${pkg().version} — install agent skills for Backbencher Brain (bb)

Usage:
  bb-skills install [options]      copy every skill into a host skills directory
  bb-skills verify [options]       check an installed directory against this package
  bb-skills check                  check the skill SOURCES in this package (CI)
  bb-skills list                   list the skills in this package
  bb-skills --help | --version

Options:
  --host <name>    claude | agents | copilot | user-claude   (default: detect)
  --scope <name>   project | user                            (default: project)
  --dir <path>     explicit skills directory (overrides --host/--scope)
  --dry-run        print the actions without writing anything
  --force          re-copy skill directories even when the manifest matches
  --json           machine-readable output
`
  process.stdout.write(text)
  process.exit(exitCode)
}
function argsOf(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run" || a === "--force" || a === "--json") out[a.slice(2)] = true
    else if (a === "--help" || a === "-h") out.help = true
    else if (a === "--version" || a === "-v") out.version = true
    else if (a === "--host" || a === "--scope" || a === "--dir") out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}
function projectScopeDir(host, cwd) {
  const map = { claude: ".claude/skills", agents: ".agents/skills", copilot: ".github/skills" }
  return map[host] ? join(cwd, map[host]) : null
}
function resolveTarget(o, cwd) {
  if (o.dir) return resolve(cwd, o.dir)
  if (o.host === "user-claude") return join(homedir(), ".claude", "skills")
  if (o.host) return projectScopeDir(o.host, cwd)
  // Detect: prefer an existing conventional directory, project scope.
  for (const host of ["agents", "claude", "copilot"]) {
    const base = projectScopeDir(host, cwd)
    const parent = dirname(base)
    if (existsSync(parent)) return base
  }
  for (const [host, dir] of Object.entries({ claude: join(homedir(), ".claude", "skills") })) {
    if (existsSync(dirname(dir))) return dir
    void host
  }
  return null
}
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"))
  } catch {
    return null
  }
}
function install(o) {
  const cwd = process.cwd()
  const target = resolveTarget(o, cwd)
  if (!target) {
    process.stderr.write(
      "bb-skills: no conventional host skills directory found. Pass --host claude|agents|copilot, --host user-claude, or --dir <path>.\n",
    )
    process.exit(2)
  }
  const names = skillNames()
  const version = pkg().version
  const before = readManifest(target)
  const actions = []
  for (const name of names) {
    const from = join(SRC, name)
    const to = join(target, name)
    const exists = existsSync(to)
    if (exists && before && before.skills?.includes(name) && !o.force) {
      actions.push({ skill: name, action: "unchanged" })
      continue
    }
    if (exists && !before?.skills?.includes(name)) {
      // Never overwrite a directory this installer did not create.
      actions.push({ skill: name, action: "skipped (not installed by bb-skills)" })
      continue
    }
    actions.push({ skill: name, action: exists ? "replaced" : "installed" })
    if (!o["dry-run"]) {
      if (o.force && exists) rmSync(to, { recursive: true, force: true })
      cpSync(from, to, { recursive: true })
    }
  }
  if (!o["dry-run"]) {
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, MANIFEST),
      JSON.stringify({ package: pkg().name, version, skills: names, installedAt: new Date().toISOString() }, null, 2) + "\n",
    )
  }
  if (o.json) process.stdout.write(JSON.stringify({ target, version, actions }, null, 2) + "\n")
  else {
    process.stdout.write(`bb-skills ${version} -> ${target}${o["dry-run"] ? "  (dry run, nothing written)" : ""}\n`)
    for (const a of actions) process.stdout.write(`  ${a.skill}: ${a.action}\n`)
  }
  return 0
}
/**
 * Check the SKILL SOURCES in this package.
 *
 * `verify` checks an INSTALLED directory; nothing checked the sources, which is how the
 * skills drifted from the product: every skill described the tools but NONE named
 * `bb help`, `man bb` or the published guide, and the README pointed at a document that is
 * not in the npm package. A skill that only restates the product goes stale silently; a
 * skill that names the RETRIEVAL path stays correct. This pins the retrieval path.
 */
function check() {
  const failures = []
  const names = skillNames()

  // Every skill must carry the discovery block. An agent loads ONE skill and never sees
  // the README, so a block present only in the README reaches nobody.
  const REQUIRED = [
    ["bb help", /`bb help`|bb <command> --help/],
    ["man bb", /`man bb`/],
    ["the published guide", /https:\/\/backbencher\.cc\/docs/],
    ["the repository", /https:\/\/github\.com\/backbencher-hq\/backbencher-brain/],
    ["bb doctor", /bb doctor/],
  ]
  for (const name of names) {
    const file = join("skills", name, "SKILL.md")
    if (!existsSync(file)) { failures.push(`${name}: SKILL.md missing`); continue }
    const text = readFileSync(file, "utf8")
    for (const [label, re] of REQUIRED) {
      if (!re.test(text)) failures.push(`${name}: does not name ${label}`)
    }
    if (!/^description:\s*Use when/m.test(text)) failures.push(`${name}: description is not a "use when" line`)
    // A doc path that does not ship reaches nobody: the package `files` list decides.
    if (/docs\/MCP_CLI_INDEXER_GUIDE\.md/.test(text)) {
      failures.push(`${name}: cites docs/MCP_CLI_INDEXER_GUIDE.md, which is not in the published package`)
    }
  }

  // The README is the canonical reference; it must name the same surfaces.
  const readme = readFileSync("README.md", "utf8")
  for (const [label, re] of REQUIRED) {
    if (!re.test(readme)) failures.push(`README.md: does not name ${label}`)
  }
  // Every tool the skills mention must be one of the 16 public tools.
  const KNOWN = new Set(["bb_search", "bb_ask", "bb_health", "bb_patterns", "bb_security", "bb_visualize",
    "bb_migrate", "bb_analyze", "bb_doc", "bb_edit", "bb_index", "bb_graph", "bb_impact",
    "bb_cross_language", "bb_annotate", "bb_annotations"])
  const cited = new Set()
  for (const name of names) {
    for (const m of readFileSync(join("skills", name, "SKILL.md"), "utf8").matchAll(/\bbb_[a-z_]+\b/g)) cited.add(m[0])
  }
  for (const tool of cited) if (!KNOWN.has(tool)) failures.push(`a skill cites an unknown tool: ${tool}`)

  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify({ skills: names.length, toolsCited: [...cited].sort(), failures, ok: failures.length === 0 }, null, 2) + "\n")
  } else if (failures.length) {
    for (const f of failures) process.stdout.write(`FAIL ${f}\n`)
  } else {
    process.stdout.write(`OK ${names.length} skills: discovery path, tool vocabulary and doc references check out\n`)
  }
  return failures.length ? 1 : 0
}

function verify(o) {
  const cwd = process.cwd()
  const target = resolveTarget(o, cwd)
  if (!target || !existsSync(target)) {
    process.stderr.write("bb-skills: install target not found; pass --dir or --host.\n")
    return 2
  }
  const names = skillNames()
  const manifest = readManifest(target)
  const failures = []
  if (!manifest) failures.push(`missing ${MANIFEST}`)
  for (const name of names) {
    const file = join(target, name, "SKILL.md")
    if (!existsSync(file)) {
      failures.push(`${name}: SKILL.md missing`)
      continue
    }
    const text = readFileSync(file, "utf8")
    if (!/^description:\s*Use when/m.test(text)) failures.push(`${name}: description is not a "use when" line`)
    if (!text.includes("agent-report.yml")) failures.push(`${name}: report line missing`)
  }
  if (o.json) process.stdout.write(JSON.stringify({ target, failures, ok: failures.length === 0 }, null, 2) + "\n")
  else if (failures.length) {
    for (const f of failures) process.stdout.write(`FAIL ${f}\n`)
  } else process.stdout.write(`OK ${target}: ${names.length}/${names.length} skills installed by ${manifest.package}@${manifest.version}\n`)
  return failures.length ? 1 : 0
}
const o = argsOf(process.argv.slice(2))
if (o.help) usage(0)
if (o.version) {
  process.stdout.write(`${pkg().version}\n`)
  process.exit(0)
}
const cmd = o._[0] ?? "install"
if (cmd === "list") {
  for (const n of skillNames()) process.stdout.write(`${n}\n`)
  process.exit(0)
}
if (cmd === "install") process.exit(install(o))
if (cmd === "verify") process.exit(verify(o))
if (cmd === "check") process.exit(check())
process.stderr.write(`bb-skills: unknown command '${cmd}'\n`)
usage(2)
