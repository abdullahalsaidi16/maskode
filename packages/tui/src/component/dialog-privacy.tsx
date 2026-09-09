import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) return <span style={{ fg: theme.textMuted }}>⋯ Updating</span>
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogPrivacy() {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const [loading, setLoading] = createSignal(false)
  const enabled = createMemo(() => {
    const config = sync.data.config as { privacy?: { enabled?: boolean } }
    return config.privacy?.enabled !== false
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      value: "attachments",
      title: "Attached text files",
      description: "Anonymize sensitive values before sending files to the model provider",
      footer: <Status enabled={enabled()} loading={loading()} />,
    },
  ])

  const actions = createMemo(() => [
    {
      command: "dialog.privacy.toggle",
      title: enabled() ? "disable" : "enable",
      onTrigger: async () => {
        if (loading()) return
        const next = !enabled()
        setLoading(true)
        await sdk.client.config
          .update(
            {
              workspace: project.workspace.current(),
              // Never write the synchronized config back because it may contain resolved secrets.
              config: { privacy: { enabled: next } } as never,
            },
            { throwOnError: true },
          )
          .then(() => sync.bootstrap({ fatal: false }))
          .then(() =>
            toast.show({
              title: `Attachment privacy ${next ? "enabled" : "disabled"}`,
              message: next
                ? "Attached text files will be anonymized before being sent."
                : "Attached files will be sent without anonymization.",
              variant: next ? "info" : "warning",
            }),
          )
          .catch(toast.error)
          .finally(() => setLoading(false))
      },
    },
  ])

  return (
    <DialogSelect
      title="Attachment privacy"
      options={options()}
      actions={actions()}
      onSelect={() => {
        // Keep the dialog open; use the displayed enable/disable action to change the setting.
      }}
    />
  )
}
