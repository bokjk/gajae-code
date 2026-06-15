# @gajae-code/telegram-remote

A tiny, safe **Telegram operator remote** for Gajae-Code (`gjc`) sessions — v0 of
[issue #681](https://github.com/Yeachan-Heo/gajae-code/issues/681), implementing the
contract fixed in [`docs/telegram-remote.md`](../../docs/telegram-remote.md).

This is a **command + bounded-read** gateway over the **Coordinator MCP**, for session
**lifecycle and observation** from a phone. It is deliberately **not** a remote RPC
cockpit, a remote shell, a config editor, or a transcript viewer. The real session owner
stays GJC/tmux/harness-side; Telegram is only the control button.

## What it does

Five commands, mapped onto Coordinator MCP tool calls:

| Command | Intent | Mutation |
| --- | --- | --- |
| `/sessions` | List live/recent sessions with concise bounded status | none (read) |
| `/observe <sessionId>` | One session's bounded public-safe status slice | none (read) |
| `/start-session <presetId> [task]` | Start a session from an **approved preset** | `sessions` |
| `/stop <sessionId>` | Request a graceful stop (confirmation required) | `reports` |
| `/help` | Show the command set | none |

Everything outside this vocabulary is rejected as unknown.

## Safety properties

- **Default deny.** Only an explicit allowlist of Telegram user/chat ids may issue any
  command. Unlisted senders get an identical, boring refusal — no hints, no enumeration.
- **Preset-only creation.** A preset binds a fixed workdir + fixed session command +
  optional fixed task template with a single length-capped, control-char-stripped
  `{{task}}` slot. No workdir/command/branch/repo/shell/raw-RPC ever comes from chat.
- **Fail-closed mutations.** The coordinator runs with the smallest mutation set
  (`sessions`, plus `reports` only when `/stop` is enabled). `questions` is never enabled.
- **Redaction by construction.** Only a typed projection (session id, derived name,
  bounded status enum, branch, timestamps, bounded turn/lifecycle enum, short sanitized
  blocker) leaves the PC. Raw tmux tail, transcripts, tool IO, diffs, file contents, env,
  system prompt, tokens/secrets, and absolute paths are never transmitted.
- **Confirmation for `/stop`.** A `/stop <id>` arms; a second `/stop <id> confirm` records
  the coordinator terminal `cancelled` status. `/stop` does **not** kill a tmux process.

## Run it

```sh
export GJC_TELEGRAM_REMOTE_BOT_TOKEN="123456:telegram-bot-token"
export GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS="11111111"   # comma-separated
export GJC_TELEGRAM_REMOTE_PRESETS='[
  {"id":"proj","workdir":"/home/bot/src/project","sessionCommand":"gjc --worktree",
   "taskTemplate":"Use /skill:ralplan to plan: {{task}}","taskMaxLen":2000}
]'
export GJC_TELEGRAM_REMOTE_ENABLE_STOP="true"            # optional; enables /stop

bun run start
```

The service spawns `gjc mcp-serve coordinator` with a forced, smallest mutation set and
long-polls the Telegram Bot API. See `.env.example` for every variable.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GJC_TELEGRAM_REMOTE_BOT_TOKEN` | **Required.** Telegram bot token. |
| `GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS` | Comma-separated allowlist of Telegram user ids. |
| `GJC_TELEGRAM_REMOTE_ALLOWED_CHAT_IDS` | Comma-separated allowlist of chat ids. At least one allowlist is required. |
| `GJC_TELEGRAM_REMOTE_PRESETS` | JSON array of presets (`id`, `workdir`, `sessionCommand`, `taskTemplate?`, `taskMaxLen?`). |
| `GJC_TELEGRAM_REMOTE_ENABLE_STOP` | `true`/`1`/`yes` to enable `/stop` (adds the `reports` mutation class). |
| `GJC_TELEGRAM_REMOTE_DEFAULT_TASK_MAX_LEN` | Default per-preset task cap (default `2000`). |
| `GJC_TELEGRAM_REMOTE_POLL_TIMEOUT_SEC` | Bot API long-poll timeout (default `30`). |
| `GJC_TELEGRAM_REMOTE_API_BASE` | Override the Telegram API base URL. |
| `GJC_TELEGRAM_REMOTE_COORDINATOR_COMMAND` | Coordinator command (default `gjc`). |
| `GJC_TELEGRAM_REMOTE_COORDINATOR_ARGS` | Coordinator args (default `mcp-serve,coordinator`). |
| `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` | Optional explicit workdir allowlist; derived from presets otherwise. |
| `GJC_COORDINATOR_MCP_SESSION_COMMAND` | Optional explicit session command; derived from presets otherwise. |
| `GJC_COORDINATOR_MCP_PROFILE` / `_REPO` / `_STATE_ROOT` / `_ARTIFACT_BYTE_CAP` | Passed through to the coordinator namespace/state config. |

`GJC_COORDINATOR_MCP_MUTATIONS` is **forced** by the gateway and cannot be widened from the
environment: `sessions` (read + start) or `sessions,reports` (with `/stop`). `questions` is
never enabled.

## Status

v0, roadmap scope. Lifecycle + observation only; no submit surface and no remote teardown.
See [`docs/telegram-remote.md`](../../docs/telegram-remote.md) for the full contract,
deferred decisions, and non-goals.
