import { describe, expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { LLMEvent } from "@opencode-ai/llm"
import { PrivacyFilter } from "../../src/session/privacy"
import { tmpdir } from "../fixture/fixture"

describe("session privacy", () => {
  test("redacts attached files only and restores streamed output", async () => {
    await using tmp = await tmpdir()
    const executable = path.join(tmp.path, "opf-local")
    const log = path.join(tmp.path, "privacy.jsonl")
    await Bun.write(
      executable,
      `#!/bin/sh
input=$(cat)
[ "$input" = "My name is Alice" ] || exit 2
printf '%s\n' 'model loading diagnostic'
printf '%s' '{"schema_version":1,"detected_spans":[{"label":"private_person","start":11,"end":16,"text":"Alice","placeholder":"<PRIVATE_PERSON>"}],"redacted_text":"My name is <PRIVATE_PERSON>"}'
`,
    )
    await chmod(executable, 0o700)
    const privacy = new PrivacyFilter({ backend: "local", executable, logPath: log })
    const chat = { role: "user", content: "My name is Alice" } as const
    const messages = await privacy.redactMessages([
      chat,
      {
        role: "user",
        content: [
          { type: "text", text: 'Called the Read tool with the following input: {"filePath":"contact.txt"}' },
          { type: "text", text: "My name is Alice" },
        ],
      },
    ])
    expect(messages[0]).toEqual(chat)
    expect(messages[1]?.content).toEqual([
      { type: "text", text: 'Called the Read tool with the following input: {"filePath":"contact.txt"}' },
      { type: "text", text: "My name is <BOGU_PRIVACY_PRIVATE_PERSON_000001>" },
    ])
    const audit = JSON.parse(await Bun.file(log).text())
    expect(audit).toMatchObject({
      event: "attached_file_sent_anonymized",
      backend: "local",
      detected: ["private_person"],
      inputCharacters: 16,
      providerText: "My name is <BOGU_PRIVACY_PRIVATE_PERSON_000001>",
    })

    expect(
      privacy.restoreEvents([
        LLMEvent.textStart({ id: "text" }),
        LLMEvent.textDelta({ id: "text", text: "Hello <BOGU_PRIVACY_" }),
        LLMEvent.textDelta({ id: "text", text: "PRIVATE_PERSON_000001>" }),
        LLMEvent.textEnd({ id: "text" }),
      ]),
    ).toEqual([
      LLMEvent.textStart({ id: "text" }),
      LLMEvent.textDelta({ id: "text", text: "Hello Alice" }),
      LLMEvent.textEnd({ id: "text" }),
    ])
  })

  test("uses Hugging Face token classification for attachments", async () => {
    const originalFetch = globalThis.fetch
    let request: Request | undefined
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init)
      return Response.json([{ entity_group: "private_email", start: 6, end: 23, word: "alice@example.com" }])
    }) as typeof fetch
    try {
      const privacy = new PrivacyFilter({
        backend: "huggingface",
        apiKey: "hf_test",
        model: "openai/privacy-filter",
        endpoint: "https://router.huggingface.co/hf-inference/models",
      })
      const messages = await privacy.redactMessages([
        {
          role: "user",
          content: [
            { type: "text", text: 'Called the Read tool with the following input: {"filePath":"contact.txt"}' },
            { type: "text", text: "Email alice@example.com" },
          ],
        },
      ])
      expect(request?.url).toBe("https://router.huggingface.co/hf-inference/models/openai/privacy-filter")
      expect(request?.headers.get("authorization")).toBe("Bearer hf_test")
      expect(messages[0]?.content).toEqual([
        { type: "text", text: 'Called the Read tool with the following input: {"filePath":"contact.txt"}' },
        { type: "text", text: "Email <BOGU_PRIVACY_PRIVATE_EMAIL_000001>" },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
