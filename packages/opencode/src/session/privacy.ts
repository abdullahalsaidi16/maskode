import { LLMEvent, type LLMEvent as Event } from "@opencode-ai/llm"
import type { ModelMessage, Tool } from "ai"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Span = {
  label: string
  start: number
  end: number
}

type Result = {
  detected_spans: Span[]
}

type HuggingFaceSpan = {
  entity_group?: string
  entity?: string
  start?: number
  end?: number
}

export type Options =
  | { backend: "local"; executable: string; logPath?: string }
  | { backend: "huggingface"; apiKey: string; model: string; endpoint: string; logPath?: string }

const ATTACHED_FILE_MARKER = "Called the Read tool with the following input:"

export class PrivacyFilter {
  private values = new Map<string, string>()
  private placeholders = new Map<string, string>()
  private counters = new Map<string, number>()
  private cache = new Map<string, string>()
  private text = new Map<string, string>()
  private reasoning = new Map<string, string>()

  constructor(private options: Options) {}

  async redactMessages(messages: ModelMessage[]) {
    const result: ModelMessage[] = []
    for (const message of messages) result.push(await this.redactAttachments(message))
    return result
  }

  wrapTools(tools: Record<string, Tool>) {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        tool.execute
          ? {
              ...tool,
              execute: (input: unknown, options: Parameters<NonNullable<Tool["execute"]>>[1]) =>
                tool.execute!(this.restoreValue(input), options),
            }
          : tool,
      ]),
    )
  }

  restoreEvents(events: ReadonlyArray<Event>) {
    return events.flatMap((event): Event[] => {
      if (LLMEvent.is.textDelta(event)) {
        this.text.set(event.id, (this.text.get(event.id) ?? "") + event.text)
        return []
      }
      if (LLMEvent.is.textEnd(event)) {
        const text = this.text.get(event.id)
        this.text.delete(event.id)
        return text === undefined ? [event] : [LLMEvent.textDelta({ id: event.id, text: this.restore(text) }), event]
      }
      if (LLMEvent.is.reasoningDelta(event)) {
        this.reasoning.set(event.id, (this.reasoning.get(event.id) ?? "") + event.text)
        return []
      }
      if (LLMEvent.is.reasoningEnd(event)) {
        const text = this.reasoning.get(event.id)
        this.reasoning.delete(event.id)
        return text === undefined ? [event] : [LLMEvent.reasoningDelta({ id: event.id, text: this.restore(text) }), event]
      }
      if (LLMEvent.is.toolCall(event)) return [LLMEvent.toolCall({ ...event, input: this.restoreValue(event.input) })]
      return [event]
    })
  }

  private async redactAttachments(message: ModelMessage): Promise<ModelMessage> {
    // Attached text files are expanded by prompt.ts into two user text parts:
    // a synthetic Read-tool marker and then the file content. Ordinary chat,
    // assistant history, and tool output deliberately bypass the filter.
    if (message.role !== "user" || !Array.isArray(message.content)) return message
    let redactNextText = false
    return {
      ...message,
      content: await (async () => {
        const content = []
        for (const part of message.content) {
          if (typeof part === "string") {
            // ModelMessage currently uses structured content here, but keep
            // strings untouched if an adapter supplies them in the future.
            content.push(part)
            redactNextText = false
            continue
          }
          if (part.type === "text") {
            if (part.text.startsWith(ATTACHED_FILE_MARKER)) {
              redactNextText = true
              content.push(part)
              continue
            }
            if (redactNextText) {
              content.push({ ...part, text: await this.redact(part.text) })
              redactNextText = false
              continue
            }
          }
          if (part.type !== "text" && redactNextText) {
            // The marker must be immediately followed by text to count as an
            // attachment. Avoid accidentally filtering a later chat message.
            redactNextText = false
          }
          content.push(part)
        }
        return content
      })(),
    } as ModelMessage
  }

  private async redactValue(value: unknown): Promise<unknown> {
    if (typeof value === "string") return this.redact(value)
    if (Array.isArray(value)) {
      const result = []
      for (const item of value) result.push(await this.redactValue(item))
      return result
    }
    if (!value || typeof value !== "object") return value
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = await this.redactValue(item)
    return result
  }

  private restoreValue(value: unknown): unknown {
    if (typeof value === "string") return this.restore(value)
    if (Array.isArray(value)) return value.map((item) => this.restoreValue(item))
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.restoreValue(item)]))
  }

  private async redact(text: string) {
    if (!text) return text
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached
    const result = this.options.backend === "local" ? await this.local(text) : await this.huggingFace(text)
    const chars = Array.from(text)
    const redacted = result.detected_spans
      .toSorted((a, b) => b.start - a.start)
      .reduce((value, span) => {
        if (span.start < 0 || span.end < span.start || span.end > chars.length) throw new Error("invalid privacy span")
        const original = chars.slice(span.start, span.end).join("")
        const key = `${span.label}\0${original}`
        const existing = this.values.get(key)
        const count = (this.counters.get(span.label) ?? 0) + 1
        const placeholder = existing ?? `<BOGU_PRIVACY_${span.label.toUpperCase()}_${String(count).padStart(6, "0")}>`
        if (!existing) {
          this.counters.set(span.label, count)
          this.values.set(key, placeholder)
          this.placeholders.set(placeholder, original)
        }
        return `${Array.from(value).slice(0, span.start).join("")}${placeholder}${Array.from(value).slice(span.end).join("")}`
      }, text)
    if (this.options.logPath)
      await appendFile(
        this.options.logPath,
        `${JSON.stringify({
          time: new Date().toISOString(),
          event: "attached_file_sent_anonymized",
          backend: this.options.backend,
          detected: result.detected_spans.map((span) => span.label),
          inputCharacters: chars.length,
          providerText: redacted,
        })}\n`,
        { mode: 0o600 },
      )
    this.cache.set(text, redacted)
    return redacted
  }

  private async local(text: string): Promise<Result> {
    if (this.options.backend !== "local") throw new Error("invalid local privacy backend")
    const dir = await mkdtemp(path.join(os.tmpdir(), "bogu-privacy-"))
    const file = path.join(dir, "attachment.txt")
    try {
      await writeFile(file, text, { encoding: "utf8", mode: 0o600 })
      const process = Bun.spawn(
        [this.options.executable, "--format", "json", "--no-print-color-coded-text", "-f", file],
        { stdout: "pipe", stderr: "pipe" },
      )
      const timeout = setTimeout(() => process.kill(), 30_000)
      const [output, error, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]).finally(() => clearTimeout(timeout))
      if (exit !== 0) throw new Error(`privacy filter failed (${exit}): ${error.trim()}`)
      return this.parseResult(output)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async huggingFace(text: string): Promise<Result> {
    if (this.options.backend !== "huggingface") throw new Error("invalid Hugging Face privacy backend")
    const modelPath = this.options.model.split("/").map(encodeURIComponent).join("/")
    const url = `${this.options.endpoint.replace(/\/$/, "")}/${modelPath}`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text, parameters: { aggregation_strategy: "simple" } }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Hugging Face privacy request failed (${response.status}): ${body.slice(0, 240)}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error(`Hugging Face privacy request returned invalid JSON: ${body.slice(0, 240)}`)
    }
    if (!Array.isArray(parsed)) throw new Error("Hugging Face privacy response is not a token-classification array")
    const spans = parsed as HuggingFaceSpan[]
    return {
      detected_spans: spans.map((span) => {
        const label = span.entity_group ?? span.entity
        if (!label || !Number.isInteger(span.start) || !Number.isInteger(span.end))
          throw new Error("Hugging Face privacy response contains an invalid span")
        return { label: label.replace(/^[BIES]-/, "").toLowerCase(), start: span.start!, end: span.end! }
      }),
    }
  }

  private restore(text: string) {
    return [...this.placeholders].reduce((value, [placeholder, original]) => value.replaceAll(placeholder, original), text)
  }

  private parseResult(output: string): Result {
    const candidates = [
      output.trim(),
      ...output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse(),
    ]
    const first = output.indexOf("{")
    const last = output.lastIndexOf("}")
    if (first !== -1 && last > first) candidates.push(output.slice(first, last + 1))
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as Partial<Result>
        if (Array.isArray(parsed.detected_spans)) return parsed as Result
      } catch {
        // Some local runners print model-loading diagnostics around the JSON.
      }
    }
    const preview = output.replace(/\s+/g, " ").trim().slice(0, 240)
    throw new Error(`privacy filter returned invalid JSON${preview ? `: ${preview}` : ": empty stdout"}`)
  }
}

export * as SessionPrivacy from "./privacy"
