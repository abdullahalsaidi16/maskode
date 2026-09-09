import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { cmd } from "./cmd"
import { PrivacyInstallation } from "@/privacy"

const InstallCommand = cmd({
  command: "install",
  describe: "download and install the local privacy model",
  builder: (yargs: Argv) =>
    yargs
      .option("ref", { type: "string", describe: "openai/privacy-filter Git ref (defaults to Bogu's tested revision)" })
      .option("python", { type: "string", describe: "Python 3.10+ executable (auto-detected by default)" })
      .option("refresh", { type: "boolean", default: false, describe: "recreate the runtime environment" }),
  handler: async (args: { ref?: string; python?: string; refresh: boolean }) => {
    prompts.intro("Bogu local privacy")
    prompts.log.info("This downloads approximately 3.2 GB of model and runtime files.")
    prompts.log.step("Installing Python runtime dependencies and downloading the model...")
    try {
      const result = await PrivacyInstallation.install(args)
      prompts.log.success("Local privacy runtime installed")
      prompts.log.info(result.executable)
      prompts.outro("Bogu will use this runtime automatically")
    } catch (error) {
      prompts.log.error(error instanceof Error ? error.message : String(error))
      prompts.outro("Installation failed")
      process.exitCode = 1
    }
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show local privacy model installation status",
  handler: () => {
    const item = PrivacyInstallation.paths()
    console.log(`installed: ${PrivacyInstallation.installed() ? "yes" : "no"}`)
    console.log(`runtime:   ${item.executable}`)
    console.log(`model:     ${item.checkpoint}`)
  },
})

const UpdateCommand = cmd({
  command: "update",
  describe: "reinstall the latest local privacy runtime and model metadata",
  builder: (yargs: Argv) =>
    yargs
      .option("ref", { type: "string", describe: "openai/privacy-filter Git ref (defaults to Bogu's tested revision)" })
      .option("python", { type: "string", describe: "Python 3.10+ executable (auto-detected by default)" }),
  handler: (args: { ref?: string; python?: string }) => InstallCommand.handler({ ...args, refresh: true } as never),
})

const UninstallCommand = cmd({
  command: "uninstall",
  describe: "remove the managed local privacy runtime and model",
  builder: (yargs: Argv) => yargs.option("force", { alias: "f", type: "boolean", default: false }),
  handler: async (args: { force: boolean }) => {
    if (!args.force) {
      const answer = await prompts.confirm({ message: `Remove ${PrivacyInstallation.root()}?`, initialValue: false })
      if (prompts.isCancel(answer) || !answer) return
    }
    await PrivacyInstallation.uninstall()
    prompts.outro("Managed privacy runtime removed")
  },
})

export const PrivacyCommand = cmd({
  command: "privacy",
  describe: "manage the local attachment privacy model",
  builder: (yargs: Argv) =>
    yargs.command(InstallCommand).command(StatusCommand).command(UpdateCommand).command(UninstallCommand).demandCommand(),
  handler: async () => {},
})
