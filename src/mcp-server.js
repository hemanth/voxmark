#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const targetDir = process.env.QF_TARGET_DIR || process.cwd();
const bridgeUrl = process.env.QF_BRIDGE_URL || `http://127.0.0.1:${process.env.QF_PORT || 4747}`;
const storageDir = path.join(targetDir, '.quick-feedback');
const sessionsDir = path.join(storageDir, 'sessions');

const TOOLS = [
  {
    name: 'get_latest_feedback',
    description:
      'Get the latest live voice + DOM annotation feedback captured from the user browser, including DOM selectors, computed styles, voice transcript, and WebMCP context.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_feedback_sessions',
    description: 'List all recorded live UI feedback sessions in the current workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional status filter (pending, executing, completed)'
        }
      }
    }
  },
  {
    name: 'list_browser_webmcp_tools',
    description:
      'List all live WebMCP (navigator.modelContext) tools registered in the active browser tab, including Voxmark DOM inspection/preview tools and app-specific tools.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'voxmark_inspect_dom',
    description:
      'Inspect any live DOM element in the active browser tab by CSS selector via WebMCP, returning its bounding box, computed styles, parent layout styles, and HTML snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to query in the live document (e.g. "#hero-header", ".metric-card")'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'voxmark_preview_styles',
    description:
      'Apply instant 0ms live CSS style overrides or text content to a DOM element in the browser tab via WebMCP to preview and verify layout before or while editing source files.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of target element(s)'
        },
        styles: {
          type: 'object',
          description: 'Key-value map of CSS properties (camelCase or kebab-case) to apply'
        },
        textContent: {
          type: 'string',
          description: 'Optional textContent override to preview'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'voxmark_highlight_element',
    description:
      'Highlight a DOM element on the user screen with an agent callout label via WebMCP.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element to highlight'
        },
        label: {
          type: 'string',
          description: 'Short status label to show on the highlight badge'
        },
        durationMs: {
          type: 'number',
          description: 'Duration in milliseconds to keep the highlight visible (default: 2500)'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'call_browser_webmcp_tool',
    description:
      'Invoke any custom WebMCP tool registered on navigator.modelContext in the active browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the registered WebMCP tool'
        },
        arguments: {
          type: 'object',
          description: 'Arguments object to pass to the tool handler'
        }
      },
      required: ['name']
    }
  }
];

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function loadAllSessions() {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function callBridgeWebMcp(name, args = {}) {
  const res = await fetch(`${bridgeUrl}/api/webmcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data.result;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'voxmark-mcp', version: '0.2.0' }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      if (toolName === 'get_latest_feedback') {
        const latestMdPath = path.join(storageDir, 'latest.md');
        if (!fs.existsSync(latestMdPath)) {
          sendResponse(id, {
            content: [{ type: 'text', text: 'No live feedback sessions recorded yet.' }]
          });
          return;
        }
        const md = fs.readFileSync(latestMdPath, 'utf8');
        sendResponse(id, {
          content: [{ type: 'text', text: md }]
        });
        return;
      }

      if (toolName === 'list_feedback_sessions') {
        const all = loadAllSessions();
        const filtered = args.status ? all.filter((s) => s.status === args.status) : all;
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                filtered.map((s) => ({
                  id: s.id,
                  url: s.url,
                  status: s.status,
                  fullTranscript: s.fullTranscript,
                  annotationsCount: s.annotations?.length || 0,
                  createdAt: s.createdAt
                })),
                null,
                2
              )
            }
          ]
        });
        return;
      }

      if (toolName === 'list_browser_webmcp_tools') {
        const res = await fetch(`${bridgeUrl}/api/webmcp/tools`);
        const data = await res.json();
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        });
        return;
      }

      if (
        toolName === 'voxmark_inspect_dom' ||
        toolName === 'voxmark_preview_styles' ||
        toolName === 'voxmark_highlight_element'
      ) {
        const result = await callBridgeWebMcp(toolName, args);
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        });
        return;
      }

      if (toolName === 'call_browser_webmcp_tool') {
        const result = await callBridgeWebMcp(args.name, args.arguments || {});
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        });
        return;
      }

      sendError(id, -32601, `Unknown tool: ${toolName}`);
    } catch (err) {
      sendResponse(id, {
        isError: true,
        content: [{ type: 'text', text: `WebMCP Error: ${err.message}` }]
      });
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
});
