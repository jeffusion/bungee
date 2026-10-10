# Captured Codex requests

`captured-app-base.json` and `captured-app-preferences.json` preserve the two
request shapes captured from desktop requests on 2026-10-09. Message bodies,
tool descriptions, identifiers and client metadata are sanitized. Tool names,
parameter schemas, custom grammar, field presence and message ordering are
retained. No authorization headers are included.

The CLI version at capture was 0.160.1; the emitting desktop client's version was not
available in the body log and is not inferred from the CLI version.

These complete samples preserve additional_tools, stream_options, custom tools and generation preferences. They are regression inputs, not proof that every Responses semantic can be represented in Anthropic: the base sample requests strict JSON Schema, and the preferences sample contains mid-conversation developer instructions. Those constraints remain explicit Anthropic rejections.
