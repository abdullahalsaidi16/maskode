# Defence.md

Security posture of **Maskode**, an unofficial privacy-focused fork of OpenCode.

This document covers two things that are easy to conflate:

1. The **defence the product provides** — the attachment privacy layer, what it actually guarantees, and where it does not.
2. The **defence of the codebase itself** — what the Norma governance scan reports, what was fixed, and which findings are knowingly accepted.

Scanner: Norma (Quality Clouds) MCP, repository `10028`, rulesets `typescript-norma-ruleset`, `javascript-norma-ruleset`, `nodejs-norma-ruleset`, `react-norma-ruleset`, `supabase-norma-ruleset`, `vite-norma-ruleset`.

---

## 1. What Maskode defends

Maskode sits between an attached text file and the coding-model provider. It classifies sensitive spans with OpenAI's [`privacy-filter`](https://huggingface.co/openai/privacy-filter), substitutes placeholders before the text leaves the machine, and restores the originals locally in model output and tool arguments.

### Trust boundaries

| Boundary | Crosses the machine? | Notes |
| --- | --- | --- |
| Attached file → classifier (`backend: "local"`) | **No** | Written to a `0600` temp file, passed to `opf-local`, temp dir removed in `finally`. |
| Attached file → classifier (`backend: "huggingface"`) | **Yes** | The **original, unredacted** text is POSTed to Hugging Face. |
| Redacted text → coding-model provider | Yes | Placeholders only, assuming the classifier detected the span. |
| Placeholder → original mapping | **No** | In-memory `Map`, per session, never persisted. |
| Audit log (`privacy.log`) | No | Contains the anonymized text only — never the mapping, never the token. |

### What is filtered, and what is not

Only attached **text-file content** is filtered. The filter keys off a synthetic marker (`Called the Read tool with the following input:`) emitted by `prompt.ts`, and redacts the text part that immediately follows it.

Deliberately **not** filtered: ordinary chat messages, assistant history, system prompts, general tool output, and binary/media attachments.

### Fail-closed behaviour

The privacy path fails closed. If the classifier errors, times out (30 s), or returns unparseable output, `llm.ts` raises `Maskode privacy filter failed: …` and the request never reaches the provider. A misconfigured Hugging Face backend without a token is rejected at construction.

---

## 2. Residual risks in the privacy layer

These are properties of the design, found by reading `packages/opencode/src/session/privacy.ts`. They are not Norma rule violations — they are the limits of what the feature can promise, and they belong in the threat model.

### R1 — Placeholders are a re-identification oracle (highest impact)

`restore()` replaces **any** occurrence of a known placeholder in model output, including inside tool-call arguments, which `wrapTools()` then executes. Placeholders are sequentially numbered and therefore guessable (`<MASKODE_PRIVACY_PRIVATE_EMAIL_000001>`).

A model that is prompt-injected — for example by a second, hostile attachment — can emit a placeholder it was never shown into a `bash` argument. The value is restored to the real secret before the tool runs, and the secret leaves the machine through the tool rather than through the prompt.

**Mitigation posture:** the placeholder namespace is per-session and in-memory, so the window is one session. Tool permission prompts remain the real control. Treat placeholder restoration as a convenience, not a containment boundary, and do not auto-approve `bash` in sessions with sensitive attachments. A randomised, non-sequential placeholder suffix would remove the guessing path.

### R2 — Placeholder collision from attachment content

If an attached file literally contains the string `<MASKODE_PRIVACY_PRIVATE_PERSON_000001>`, `restore()` will rewrite it to an unrelated secret from the same session. Low likelihood, easy to fix by rejecting attachment text matching the placeholder pattern.

### R3 — Classifier recall is the actual security ceiling

Everything rests on `privacy-filter` detecting the span. Anything it misses is sent verbatim. This is defence in depth, not a guarantee — as `docs/MASKODE_PRIVACY.md` already states.

### R4 — Hugging Face backend defeats the premise for the file itself

With `backend: "huggingface"`, the original text reaches a third party by design. Correct for "lightweight setup", wrong for "the file must never leave the machine". The README table says so; keep it that way.

### R5 — Audit log holds undetected sensitive text

`privacy.log` records `providerText`, which is exactly what the provider saw — including anything the classifier missed. The `appendFile` `mode: 0o600` applies only when the file is created; a pre-existing file keeps its own permissions. Treat the log as sensitive and prefer a fresh path.

### R6 — Unbounded per-session maps

`cache`, `placeholders`, `values`, and `counters` grow for the life of a session and are never evicted. A long session over many large attachments holds every redacted attachment and every recovered secret in memory. Bounded, but only by session length.

### R7 — Dead code: `redactValue` is unreachable

`redactValue` is only ever called by itself; no entry point invokes it. Outbound tool **inputs** are therefore never redacted. In practice the model only sees redacted text, so this is a latent gap rather than an active hole — but it should be either wired up or deleted, not left ambiguous.

### R8 — Managed model install is a supply-chain surface

`privacy install` downloads `openai/privacy-filter` pinned to commit `f7f00ca7…`, extracts it with `tar`, creates a venv, and `pip install`s it. The Git ref is pinned; the **tarball contents are not checksum-verified**, and `--ref` accepts any revision. `install.sh` does verify the Maskode binary against a published `.sha256`. Installing a pinned upstream ref is reasonable; adding an archive checksum would close the gap.

---

## 3. Norma scan results

### Repository-wide (last full scan)

**5,490 open issues.** The overwhelming majority are in inherited OpenCode code, not in the fork's own changes.

| Severity / area | Count | Assessment |
| --- | --- | --- |
| HIGH / scalability (`js-no-error-handling-async`) | 3,742 | Rule noise — see §4. |
| MEDIUM / manageability | 889 | Mostly `ts-any-type-usage`, inherited. |
| MEDIUM / scalability | 271 | Inherited. |
| LOW+MEDIUM / maintainability | 380 | Inherited. |
| HIGH / security | small tail | See below. |

Highest-severity security findings, all in **inherited upstream code**:

- `js-inner-html-assignment` — `packages/ui/src/components/markdown.tsx`, `packages/app/src/components/file-tree.tsx`
- `js-postmessage-no-origin` — `packages/web/src/components/Share.tsx`, `packages/opencode/src/server/proxy.ts`, `packages/desktop/src/loading.tsx`, `packages/app/src/components/terminal.tsx`
- `js-eval-usage` — `packages/opencode/src/cli/cmd/debug/agent.ts`

These are upstream OpenCode surface. They are real and worth carrying upstream, but changing them here creates rebase friction against OpenCode for no privacy benefit. Tracked, not fixed in this pass.

Full list: <https://norma.qualityclouds.com/repositories/10028>

### Fork-owned files

Scoped scan of the privacy layer (`session/privacy.ts`, `privacy/installation.ts`, `cli/cmd/privacy.ts`, `session/llm.ts`, `tui/component/dialog-privacy.tsx`, `core/…/config.ts`) returned **one** recorded open issue, plus one HIGH surfaced by Livecheck.

Notably, **zero** secret-exposure findings — no hardcoded API keys, bearer tokens, private key material, or connection strings. `HF_TOKEN` is resolved from the environment or `{env:HF_TOKEN}` config interpolation, and the `/privacy` TUI dialog writes back only the boolean, so a resolved token is never persisted to `opencode.json`.

---

## 4. Applied and accepted

### Fixed

**`js-empty-catch-block` (HIGH, manageability) — `packages/opencode/src/session/privacy.ts`, `parseResult()`**

The candidate-parsing loop swallowed every `JSON.parse` failure into an empty `catch`. Failing candidates are expected there — local runners print model-loading diagnostics around the JSON — but when *all* candidates failed, the reason was discarded and the fail-closed error reported only a truncated preview of stdout. Since this path blocks the request, a bad local runtime was harder to diagnose than it needed to be.

The last parse failure is now retained and appended to the thrown error. Verified: `bun test test/session/privacy.test.ts` → 2 pass, 0 fail; Livecheck re-run confirms the finding cleared (15 → 14 findings).

### Accepted, not fixed

**`js-no-error-handling-async` (HIGH, scalability) — 3,742 repo-wide, 14 in `session/privacy.ts`, 20 in `privacy/installation.ts`**

The rule flags every `await` not lexically wrapped in `try`/`catch`. It does not model error handling at a boundary, which is how this codebase works:

- Privacy redaction is wrapped by the caller in `llm.ts` via `Effect.tryPromise`, which converts any failure into `Maskode privacy filter failed: …`.
- `PrivacyInstallation.install()` is wrapped by its CLI handler in `cli/cmd/privacy.ts`, which catches, reports through `prompts.log.error`, and sets `process.exitCode = 1`.
- `local()` already uses `try`/`finally` to guarantee temp-directory cleanup.

Wrapping each individual `await` would add noise and, in the redaction path, risk converting a fail-closed error into a swallowed one — the opposite of what this fork exists to do. **Deliberate deviation.**

**`ts-any-type-usage` (MEDIUM, manageability) — `packages/opencode/src/session/llm.ts`**

The single recorded open issue in fork-touched files. `git blame` attributes it to upstream OpenCode, not to this fork:

```ts
} catch (e: any) {
  return { result: "", error: e.message ?? String(e) }
}
```

Left in place to keep the rebase surface against OpenCode clean. The fix belongs upstream:

```ts
} catch (e) {
  return { result: "", error: e instanceof Error ? e.message : String(e) }
}
```

Note: Norma reported this at line 271; it is actually at line 200. Scan line numbers are as-of the last full scan — re-locate by pattern, as Norma's own guidance says.

### Scan coverage caveat

Every Livecheck run reported `coverage.reduced: true` — one semgrep rule could not be evaluated within the fault-isolation budget. These results are a floor, not a ceiling. Do not read "no findings" as "clean".

---

## 5. Operational guidance

- **Prefer `backend: "local"`.** Use Hugging Face only when the file itself may leave the machine.
- **Do not auto-approve `bash`** in sessions with sensitive attachments — see R1.
- **Treat `privacy.log` as sensitive.** It contains what the provider saw, including misses.
- **Privacy is not a substitute for not attaching the file.** The classifier has finite recall.
- **Report vulnerabilities** per [SECURITY.md](SECURITY.md).

---

*Norma scan and fix: Claude Opus 5. Findings recorded to the Norma compliance audit trail.*
