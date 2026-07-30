# Pi

- Built-in name: `pi`
- Default command: `npx pi-acp`
- Adapter: https://github.com/svkozak/pi-acp
- Upstream agent: https://github.com/mariozechner/pi

`acpx pi` starts Pi through the `pi-acp` stdio adapter. ACPX owns the built-in
adapter range so the friendly name remains reproducible without requiring a
separately installed global adapter.
