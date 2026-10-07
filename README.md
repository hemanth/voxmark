# voxmark

Point at your app, say what you want changed out loud, and watch your code update itself in real time.



https://github.com/user-attachments/assets/4ed7a09e-1308-4565-b865-01560d155ada



```bash
npm install -g voxmark
```

## Quick start

```js
import voxmark from 'voxmark';

const bridge = await voxmark('./my-app');
bridge.on('feedback', (s) => console.log(s.fullTranscript, s.annotations));
```

`voxmark()` starts the local voice + WebMCP bridge (`http://127.0.0.1:4747`). `bridge.on('feedback')` streams element-bound voice annotations. `bridge.stop()` shuts it down. That's the whole API.

## CLI

```bash
voxmark --dir /path/to/your/app
```

Press `Alt+F` on your page, click or circle any DOM element while speaking (`"center this header"`, `"make this button emerald and animate"`), and hit `Apply`. `voxmark` previews styles directly in the DOM via WebMCP (`navigator.modelContext`), pre-resolves 1-indexed source lines, runs a single-turn edit with your coding agent, and refreshes the page.

- `-d, --dir <path>` — target project directory for the agent to edit (default: `cwd`)
- `-a, --agent <name>` — coding agent CLI to execute (`agy`, `claude`, default: `agy`)
- `-c, --conversation <id>` — continue a specific Antigravity conversation ID
- `-p, --port <number>` — local bridge port (default: `4747`)
- `--no-exec` — save `.quick-feedback/latest.md` without auto-running the agent

## Drop-in script

```html
<script src="http://127.0.0.1:4747/overlay.js"></script>
```

Injects the Shadow-DOM voice and annotation HUD + `navigator.modelContext` WebMCP tools (`voxmark_get_annotations`, `voxmark_inspect_element`, `voxmark_preview_styles`) into any local app without installing the Chrome extension.

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

Exposes `get_latest_feedback`, `list_feedback_sessions`, `list_webmcp_tools`, and `call_webmcp_tool` over stdio for any MCP-compatible agent.

## Demo

```bash
voxmark --demo
```

Starts the interactive sandbox at `http://127.0.0.1:4747/demo` ready for voice and DOM annotations.

## License

MIT © [Hemanth.HM](https://h3manth.com)
