import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { UI } from "../ui"

const REPOSITORY = "abdullahalsaidi16/maskode"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade Maskode to the latest or a specific version",
  builder: (yargs: Argv) =>
    yargs.positional("target", {
      describe: "version to upgrade to, for example '0.2.1' or 'v0.2.1'",
      type: "string",
    }),
  handler: async (args: { target?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade Maskode")

    const target = args.target?.replace(/^v/, "") ?? (await latest())
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(target)) {
      prompts.log.error(`Invalid Maskode version: ${target}`)
      prompts.outro("Done")
      return
    }
    if (InstallationVersion === target) {
      prompts.log.warn(`Maskode ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading Maskode...")
    const file = path.join(os.tmpdir(), `maskode-install-${process.pid}.sh`)
    const error = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/v${target}/install.sh`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`installer download failed (${response.status})`)
        await Bun.write(file, await response.text())
        const child = Bun.spawn(["sh", file, "--without-privacy-model"], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: {
            ...process.env,
            MASKODE_INSTALL_DIR: path.dirname(process.execPath),
            MASKODE_RELEASE_BASE: `https://github.com/${REPOSITORY}/releases/download/v${target}`,
          },
        })
        if ((await child.exited) !== 0) throw new Error("Maskode installer failed")
      })
      .catch((cause) => (cause instanceof Error ? cause : new Error(String(cause))))
      .finally(() => fs.rm(file, { force: true }))

    if (error) {
      spinner.stop("Upgrade failed", 1)
      prompts.log.error(error.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Restart Maskode to use the new version")
  },
}

async function latest() {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`latest release lookup failed (${response.status})`)
  const result = (await response.json()) as { tag_name?: unknown }
  if (typeof result.tag_name !== "string") throw new Error("latest release response did not include a tag")
  return result.tag_name.replace(/^v/, "")
}
