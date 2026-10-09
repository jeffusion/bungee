# Captured Codex requests

`captured-app-base.json` and `captured-app-preferences.json` preserve the two
request shapes rejected by the local gateway on 2026-10-09. Message bodies,
tool descriptions, identifiers and client metadata are sanitized. Tool names,
parameter schemas, custom grammar, field presence and message ordering are
retained. No authorization headers are included.

The installed CLI is 0.160.1; the emitting desktop client's version was not
available in the body log and is not inferred from the CLI version.

Before the repair, both target protocols rejected the base sample at
`additional_tools`, and the preferences sample at `stream_options`. These
complete samples are regression inputs, not proof that every Responses
semantic can be represented in Anthropic: the base sample requests strict
JSON Schema, and the preferences sample contains mid-conversation developer
instructions. Those constraints remain explicit Anthropic rejections.
