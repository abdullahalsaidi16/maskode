import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const MODEL_ID = "openai/privacy-filter"
export const DEFAULT_REF = "f7f00ca7fb869683eb732c010299d901457f19c3"

export function root() {
  const data =
    process.env.MASKODE_DATA_DIR ??
    process.env.BOGU_DATA_DIR ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".local", "share")
  return path.join(data, "maskode", "privacy")
}

export function legacyPaths() {
  const data = process.env.BOGU_DATA_DIR ?? process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  const dir = path.join(data, "bogu", "privacy")
  return { executable: path.join(dir, "opf-local") }
}

export function paths() {
  const dir = root()
  return {
    root: dir,
    executable: path.join(dir, "opf-local"),
    source: path.join(dir, "source"),
    venv: path.join(dir, ".venv"),
    checkpointRoot: path.join(dir, "checkpoint"),
    checkpoint: path.join(dir, "checkpoint", "original"),
    metadata: path.join(dir, "installation.json"),
  }
}

export function installed() {
  const item = paths()
  return existsSync(item.executable) && existsSync(path.join(item.checkpoint, "model.safetensors"))
}

async function run(command: string[], cwd?: string) {
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const exit = await child.exited
  if (exit !== 0) throw new Error(`command failed (${exit}): ${command.join(" ")}`)
}

function pythonVersion(executable: string) {
  const result = Bun.spawnSync([
    executable,
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
  ])
  if (result.exitCode !== 0) return
  const match = result.stdout
    .toString()
    .trim()
    .match(/^(\d+)\.(\d+)$/)
  if (!match) return
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function compatiblePython(requested?: string) {
  const candidates = requested ? [requested] : ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]
  for (const candidate of candidates) {
    const executable = Bun.which(candidate)
    if (!executable) continue
    const version = pythonVersion(executable)
    if (version && (version.major > 3 || (version.major === 3 && version.minor >= 10))) return executable
  }
  throw new Error(
    requested
      ? `${requested} must be Python 3.10 or newer`
      : "Python 3.10+ is required. On macOS run: brew install python@3.12",
  )
}

export async function install(input: { ref?: string; python?: string; refresh?: boolean } = {}) {
  if (process.platform === "win32")
    throw new Error("managed local privacy installation currently supports macOS and Linux")
  const item = paths()
  const ref = input.ref ?? DEFAULT_REF
  const python = compatiblePython(input.python)
  await fs.mkdir(item.root, { recursive: true, mode: 0o700 })

  if (input.refresh) {
    await fs.rm(item.source, { recursive: true, force: true })
    await fs.rm(item.venv, { recursive: true, force: true })
  }

  if (!existsSync(path.join(item.source, "pyproject.toml"))) {
    const archive = path.join(item.root, "privacy-filter.tar.gz")
    const url = `https://github.com/openai/privacy-filter/archive/${encodeURIComponent(ref)}.tar.gz`
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" })
    if (!response.ok) throw new Error(`failed to download privacy-filter (${response.status})`)
    await Bun.write(archive, await response.arrayBuffer())
    await fs.mkdir(item.source, { recursive: true })
    try {
      await run(["tar", "-xzf", archive, "--strip-components=1", "-C", item.source])
    } finally {
      await fs.rm(archive, { force: true })
    }
  }

  const venvPython = path.join(item.venv, "bin", "python")
  const existingVersion = existsSync(venvPython) ? pythonVersion(venvPython) : undefined
  if (existingVersion && existingVersion.major === 3 && existingVersion.minor < 10)
    await fs.rm(item.venv, { recursive: true, force: true })
  if (!existsSync(venvPython)) await run([python, "-m", "venv", item.venv])
  await run([path.join(item.venv, "bin", "python"), "-m", "pip", "install", "--upgrade", "pip"])
  await run([path.join(item.venv, "bin", "python"), "-m", "pip", "install", item.source])
  await fs.mkdir(item.checkpointRoot, { recursive: true })
  await run([
    path.join(item.venv, "bin", "hf"),
    "download",
    MODEL_ID,
    "--include",
    "original/*",
    "--local-dir",
    item.checkpointRoot,
  ])

  const launcher = `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export OPF_CHECKPOINT="$root/checkpoint/original"
export TIKTOKEN_CACHE_DIR="$root/tiktoken-cache"
exec "$root/.venv/bin/opf" --device cpu "$@"
`
  await Bun.write(item.executable, launcher)
  await fs.chmod(item.executable, 0o700)
  await Bun.write(
    item.metadata,
    JSON.stringify({ schema: 1, source: "https://github.com/openai/privacy-filter", ref, model: MODEL_ID }, null, 2) +
      "\n",
  )
  return item
}

export async function uninstall() {
  await fs.rm(root(), { recursive: true, force: true })
}
