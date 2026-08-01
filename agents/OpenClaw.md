# OpenClaw

- Built-in name: `openclaw`
- Default command: `openclaw acp`
- Upstream: https://github.com/openclaw/openclaw

For a repo-local OpenClaw checkout, override the built-in with structured
`argv`. This avoids shell parsing and keeps paths and arguments intact:

```json
{
  "agents": {
    "openclaw": {
      "argv": [
        "env",
        "OPENCLAW_HIDE_BANNER=1",
        "OPENCLAW_SUPPRESS_NOTES=1",
        "node",
        "scripts/run-node.mjs",
        "acp",
        "--url",
        "ws://127.0.0.1:18789",
        "--token-file",
        "/absolute/path/to/.openclaw/gateway.token",
        "--session",
        "agent:main:main"
      ]
    }
  }
}
```

The `env` form is Unix-specific. On Windows, use a wrapper that sets the
environment variables and put the wrapper plus its arguments in `argv`.
