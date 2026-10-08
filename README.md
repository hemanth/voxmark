# voxmark

Point at your app, say what you want changed out loud, and watch your code update itself in real time.



https://github.com/user-attachments/assets/4ed7a09e-1308-4565-b865-01560d155ada



```bash
npm install -g voxmark
```

## Quick start

```js
import voxmark from 'voxmark';

const bridge = await voxmark('./my-app', {
  agent: 'agy',
  open: true
});

bridge.on('feedback', (session) => {
  console.log(session.fullTranscript);
  console.log(session.annotations); // [{ kind, selector, tagName, transcript, componentInfo, ... }]
});

// Later:
// await bridge.stop();
```

`voxmark()` binds to your app (proxying your running dev server, auto-starting `npm run dev`, or serving static HTML), injects the Shadow-DOM voice + annotation HUD, and opens the bound URL in your browser. `bridge.on('feedback')` emits each recorded voice + DOM session. `bridge.stop()` shuts down the bridge and any spawned dev server. That's the whole API.

## CLI

```bash
# Run inside any web project (auto-detects dev server or serves static HTML)
voxmark

# Point at a specific directory or running dev server URL
voxmark ./my-app
voxmark http://localhost:5173

# Short alias (`vm`) with explicit agent
vm ./my-app --agent claude
```

Press `Alt+F` on your page, click or circle any DOM element while speaking (`"center this header and make it bold"`, `"make this button emerald"`), and hit `Apply`. `voxmark` applies an instant 0ms style preview in the live DOM, pre-resolves the target component hierarchy and 1-indexed source lines, dispatches a single-turn edit to your coding agent, and hot-reloads the page when the file changes.

- `-u, --url <url>` — upstream dev server URL to proxy and inject the overlay into (auto-detected by CWD if omitted)
- `-d, --dir <path>` — target project directory for the agent to edit (default: `cwd`)
- `-a, --agent <name>` — coding agent CLI to execute (`agy`, `claude`, `codex`, `gemini`, default: `agy`)
- `-c, --conversation <id>` — continue a specific Antigravity conversation ID
- `-p, --port <number>` — preferred bridge port; auto-picks the next free port when running multiple apps concurrently (default: `4747`)
- `--no-open` — do not auto-open the bound URL in the browser on start
- `--no-exec` — write `.quick-feedback/latest.md` without auto-running the coding agent
- `--demo` — launch the built-in interactive sandbox on `/demo`

## WebMCP live DOM tools

```bash
curl -X POST http://127.0.0.1:4747/api/webmcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "voxmark_preview_styles",
    "arguments": {
      "selector": ".hero-cta",
      "styles": { "backgroundColor": "#22c55e", "borderRadius": "9999px" }
    }
  }'
```

The browser overlay registers live tools on `navigator.modelContext` (`voxmark_get_annotations`, `voxmark_inspect_dom`, `voxmark_preview_styles`, `voxmark_highlight_element`) and bridges them to `GET /.well-known/mcp.json` and `POST /api/webmcp/call` so coding agents can inspect computed layout and preview CSS changes in 0ms before writing to disk.

## Prompt & component resolution

```js
import { buildAgentPrompt, runCodingAgent } from 'voxmark';

const prompt = buildAgentPrompt(session, { targetDir: './my-app' });
const result = await runCodingAgent({
  prompt,
  targetDir: './my-app',
  agent: 'agy'
});
```

`buildAgentPrompt()` maps selected DOM nodes back to their React, Vue, Svelte, or HTML source files, extracts parent/child component trees and props, and embeds 1-indexed source slices directly into `.quick-feedback/latest.md`. `runCodingAgent()` keeps a warm agent session ready per project directory for low-latency single-turn edits.

## Drop-in script & Chrome extension

```html
<script src="http://127.0.0.1:4747/overlay.js"></script>
```

When serving or proxying through `voxmark`, `/overlay.js` is injected automatically into HTML responses. For external origins, drop the `<script>` tag into your HTML or load the unpacked Manifest V3 extension from `extension/` in `chrome://extensions`.

## MCP server

```json
{
  "mcpServers": {
    "voxmark": {
      "command": "npx",
      "args": ["voxmark/mcp"]
    }
  }
}
```

Exposes `get_latest_feedback`, `list_feedback_sessions`, `list_webmcp_tools`, and `call_webmcp_tool` over stdio for any MCP-compatible client.

## Demo

```bash
voxmark --demo
```

Starts the built-in interactive playground at `http://127.0.0.1:4747/demo` to test voice annotations, region lasso, and WebMCP live previews.

## License

MIT © [Hemanth.HM](https://h3manth.com)
