# Changelog

## [Unreleased]

### Added

- Initial v0 Telegram Remote gateway (`@gajae-code/telegram-remote`) for issue #681: a tiny,
  safe command + bounded-read operator surface over the Coordinator MCP.
  - Five-command vocabulary: `/sessions`, `/observe`, `/start-session`, `/stop`, `/help`.
  - Default-deny authorization with an identical, boring refusal for unlisted senders.
  - Preset-only session creation (fixed workdir + session command + single length-capped,
    control-char-stripped `{{task}}` slot); no workdir/command/shell/RPC from chat.
  - Fail-closed mutation gating with the smallest set (`sessions`, plus `reports` for
    `/stop`); `questions` is never enabled.
  - Transmitted-data allowlist: typed, redacted projection only — never raw tail,
    transcripts, tool IO, diffs, file contents, env, secrets, or absolute paths.
  - `/stop` confirmation gating that records the coordinator terminal `cancelled` status
    (not a process kill).
  - MCP stdio coordinator client, Bot API long-poll transport, env config loader, and a
    runnable service entry point (`gjc-telegram-remote`).
