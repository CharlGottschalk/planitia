---
name: planitia
description: Create and manage TypeScript MCP servers with the Planitia CLI. Use when the user asks to create, generate or scaffold an MCP server (Postgres queries, HTTP APIs or webhooks, payload validation, CSV/JSON transforms), or to list, add or implement tools in a Planitia-generated project (one with a planitia.json). Not for MCP servers written by hand.
---

# Planitia

Before doing anything else, run:

```sh
planitia guide
```

If `planitia` isn't installed, use `npx -y planitia guide`.

Follow the printed guide exactly. It matches the installed version of Planitia, so it overrides
anything you remember about Planitia's commands. Never ask for, pass or write secret values: show
the user the env var names to set instead.
