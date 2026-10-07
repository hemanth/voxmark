import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAgentPrompt } from './prompt-builder.js';
import { runCodingAgent, warmUpCodingAgent, closeWarmAgents } from './agent-runner.js';
import {
  injectOverlayIntoHtml,
  detectListeningPortByCwd,
  spawnAppDevServer,
  resolveStaticFile,
  proxyHttpRequest,
  forwardWebSocketUpgrade
} from './app-target.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};


const NAMED_COLOR_PALETTE = {
  red: { background: '#ef4444', color: '#ffffff', borderColor: '#f87171' },
  emerald: { background: '#22c55e', color: '#052e16', borderColor: '#4ade80' },
  green: { background: '#22c55e', color: '#052e16', borderColor: '#4ade80' },
  blue: { background: '#3b82f6', color: '#ffffff', borderColor: '#60a5fa' },
  yellow: { background: '#facc15', color: '#09090b', borderColor: '#fde047' },
  amber: { background: '#f59e0b', color: '#09090b', borderColor: '#fbbf24' },
  orange: { background: '#f97316', color: '#ffffff', borderColor: '#fb923c' },
  purple: { background: '#a855f7', color: '#ffffff', borderColor: '#c084fc' },
  violet: { background: '#8b5cf6', color: '#ffffff', borderColor: '#a78bfa' },
  pink: { background: '#ec4899', color: '#ffffff', borderColor: '#f472b6' },
  cyan: { background: '#06b6d4', color: '#083344', borderColor: '#22d3ee' },
  white: { background: '#ffffff', color: '#09090b', borderColor: '#e4e4e7' }
};

function inferInstantPreviewStyles(transcript = '', tagName = '') {
  const t = transcript.toLowerCase();
  const styles = {};
  const isButtonLike = tagName.toLowerCase() === 'button' || t.includes('button') || t.includes('background') || t.includes('card');

  for (const [name, palette] of Object.entries(NAMED_COLOR_PALETTE)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      if (isButtonLike && !t.includes('text color')) {
        styles.background = palette.background;
        styles.backgroundColor = palette.background;
        styles.color = palette.color;
        styles.borderColor = palette.borderColor;
      } else {
        styles.color = palette.background;
      }
      break;
    }
  }

  if (/\bcenter\b/.test(t)) {
    styles.textAlign = 'center';
    styles.justifyContent = 'center';
    styles.marginLeft = 'auto';
    styles.marginRight = 'auto';
  } else if (/\bleft\b/.test(t) && t.includes('align')) {
    styles.textAlign = 'left';
  } else if (/\bright\b/.test(t) && t.includes('align')) {
    styles.textAlign = 'right';
  }

  if (/\b(pill|fully rounded)\b/.test(t)) {
    styles.borderRadius = '9999px';
  } else if (/\brounded\b/.test(t)) {
    styles.borderRadius = '14px';
  }

  if (/\b(bigger|larger)\b/.test(t)) {
    styles.transform = 'scale(1.06)';
  } else if (/\bsmaller\b/.test(t)) {
    styles.transform = 'scale(0.92)';
  }

  return Object.keys(styles).length > 0 ? styles : null;
}

export function openUrlInBrowser(url) {
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function listenOnAvailablePort(server, preferredPort, host, maxRetries = 25) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let currentPort = Number(preferredPort) || 0;

    const tryListen = () => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && attempt < maxRetries) {
          attempt++;
          currentPort = currentPort > 0 && attempt < maxRetries ? currentPort + 1 : 0;
          tryListen();
        } else {
          reject(err);
        }
      };

      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address());
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(currentPort, host);
    };

    tryListen();
  });
}

/**
 * Creates and starts the Voxmark local bridge server.
 */
export function createFeedbackServer(options = {}) {
  const {
    port = Number(process.env.VOXMARK_PORT || process.env.QF_PORT || 4747),
    host = '127.0.0.1',
    targetDir: rawTargetDir = process.cwd(),
    targetUrl = process.env.VOXMARK_URL || process.env.QF_URL || null,
    demo = false,
    openBrowser = false,
    agent = process.env.QF_AGENT || 'agy',
    autoExecute = true,
    autoStartApp = undefined,
    conversationId = null,
    onFeedbackReceived = null,
    customAgentRunner = runCodingAgent
  } = options;

  const agentRunner = typeof customAgentRunner === 'function' ? customAgentRunner : runCodingAgent;

  let targetDir = path.resolve(rawTargetDir);
  let explicitHtmlFile = null;
  try {
    if (fs.existsSync(targetDir) && fs.statSync(targetDir).isFile()) {
      explicitHtmlFile = path.basename(targetDir);
      targetDir = path.dirname(targetDir);
    }
  } catch {}

  const shouldAutoStartApp =
    autoStartApp !== undefined ? Boolean(autoStartApp) : Boolean(autoExecute && agentRunner === runCodingAgent);

  let resolvedTargetUrl = targetUrl || null;
  let spawnedDevChild = null;
  let fileWatcher = null;
  let watchDebounceTimer = null;
  const isSelfRepo = path.resolve(targetDir) === PKG_ROOT;

  const storageDir = path.join(targetDir, '.quick-feedback');
  const sessionsDir = path.join(storageDir, 'sessions');

  fs.mkdirSync(sessionsDir, { recursive: true });

  const sseClients = new Set();
  const sessions = [];
  let activeJob = null;

  // Live in-browser WebMCP (navigator.modelContext) state & RPC call map
  let browserWebMcpState = {
    url: null,
    title: null,
    tools: [],
    updatedAt: null
  };
  const pendingWebMcpCalls = new Map();

  function getActivePort() {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : port;
  }

  function getBridgeOrigin() {
    return `http://${host}:${getActivePort()}`;
  }

  function broadcastEvent(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function callBrowserWebMcpTool(name, args = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (sseClients.size === 0) {
        reject(new Error('No active browser tab connected to Voxmark SSE stream'));
        return;
      }
      const callId = `wmcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        pendingWebMcpCalls.delete(callId);
        reject(new Error(`WebMCP tool call timed out after ${timeoutMs}ms: ${name}`));
      }, timeoutMs);

      pendingWebMcpCalls.set(callId, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      broadcastEvent({
        type: 'webmcp_call',
        callId,
        name,
        arguments: args
      });
    });
  }

  function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${getActivePort()}`}`);

    // 1. Health check
    if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'voxmark',
          agent,
          targetDir,
          targetUrl: resolvedTargetUrl,
          demo,
          autoExecute,
          activeJob,
          sessionsCount: sessions.length,
          webmcp: {
            connectedTabs: sseClients.size,
            toolsCount: browserWebMcpState.tools.length,
            tools: browserWebMcpState.tools.map((t) => t.name)
          }
        })
      );
      return;
    }

    // 1b. SEP-1649 MCP Server Card (/.well-known/mcp/server-card.json)
    if (req.method === 'GET' && reqUrl.pathname === '/.well-known/mcp/server-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            $schema: 'https://modelcontextprotocol.io/schemas/server-card/v1.json',
            name: 'voxmark-webmcp-bridge',
            version: '0.3.0',
            description: 'Voxmark Live Voice, DOM Annotation & In-Browser WebMCP Bridge',
            transport: {
              type: 'sse',
              endpoint: `${getBridgeOrigin()}/api/events`
            },
            capabilities: {
              tools: true,
              resources: false,
              prompts: false
            },
            tools: browserWebMcpState.tools
          },
          null,
          2
        )
      );
      return;
    }

    // 1c. WebMCP Tool Sync from Browser (POST /api/webmcp/sync)
    if (req.method === 'POST' && reqUrl.pathname === '/api/webmcp/sync') {
      try {
        const body = JSON.parse(await readRequestBody(req));
        browserWebMcpState = {
          url: body.url || null,
          title: body.title || null,
          tools: Array.isArray(body.tools) ? body.tools : [],
          updatedAt: new Date().toISOString()
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, count: browserWebMcpState.tools.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // 1d. List Live Browser WebMCP Tools (GET /api/webmcp/tools)
    if (req.method === 'GET' && reqUrl.pathname === '/api/webmcp/tools') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          connectedTabs: sseClients.size,
          ...browserWebMcpState
        })
      );
      return;
    }

    // 1e. Invoke a Live Browser WebMCP Tool (POST /api/webmcp/call)
    if (req.method === 'POST' && reqUrl.pathname === '/api/webmcp/call') {
      try {
        const body = JSON.parse(await readRequestBody(req));
        const { name, arguments: toolArgs = {} } = body;
        if (!name) throw new Error('Missing tool "name"');
        const result = await callBrowserWebMcpTool(name, toolArgs);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, name, result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // 1f. Receive WebMCP Tool Execution Result from Browser (POST /api/webmcp/result)
    if (req.method === 'POST' && reqUrl.pathname === '/api/webmcp/result') {
      try {
        const body = JSON.parse(await readRequestBody(req));
        const pending = pendingWebMcpCalls.get(body.callId);
        if (pending) {
          pendingWebMcpCalls.delete(body.callId);
          if (body.ok) pending.resolve(body.result);
          else pending.reject(new Error(body.error || 'WebMCP execution failed'));
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // 2. SSE live stream for agent progress back to the browser
    if (req.method === 'GET' && reqUrl.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', targetDir, agent, activeJob })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // 3. List captured feedback sessions
    if (req.method === 'GET' && reqUrl.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ sessions, activeJob }));
      return;
    }

    // 4. Receive new voice + DOM annotation feedback
    if (req.method === 'POST' && reqUrl.pathname === '/api/feedback') {
      try {
        const rawBody = await readRequestBody(req);
        const body = JSON.parse(rawBody);
        const id = `vm-${Date.now()}`;

        const webmcpTools = Array.isArray(body.webmcpTools)
          ? body.webmcpTools
          : browserWebMcpState.tools;

        const session = {
          id,
          url: body.url || 'unknown',
          title: body.title || '',
          viewport: body.viewport || {},
          fullTranscript: body.fullTranscript || '',
          annotations: Array.isArray(body.annotations) ? body.annotations : [],
          webmcpTools,
          status: autoExecute ? 'executing' : 'pending',
          steps: [],
          createdAt: body.createdAt || new Date().toISOString()
        };

        const prompt = buildAgentPrompt(session, {
          targetDir,
          bridgeUrl: getBridgeOrigin()
        });
        session.prompt = prompt;

        // Save markdown and JSON artifacts
        fs.writeFileSync(path.join(storageDir, 'latest.md'), prompt, 'utf8');
        fs.writeFileSync(path.join(sessionsDir, `${id}.md`), prompt, 'utf8');
        fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2), 'utf8');

        sessions.unshift(session);
        if (typeof onFeedbackReceived === 'function') {
          onFeedbackReceived(session);
        }

        if (autoExecute) {
          activeJob = {
            sessionId: id,
            startedAt: Date.now(),
            fullTranscript: session.fullTranscript,
            annotations: session.annotations.map((a) => ({
              number: a.number,
              selector: a.selector,
              transcript: a.transcript
            })),
            steps: [
              {
                kind: 'init',
                action: 'DOM Bound',
                detail: `${session.annotations.length} selector(s) bound via WebMCP`,
                timestamp: new Date().toISOString()
              }
            ]
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            id,
            status: session.status,
            promptFile: path.join(storageDir, 'latest.md')
          })
        );

        // Instant 0ms WebMCP highlight + live style preview in browser while agent edits disk
        if (sseClients.size > 0 && session.annotations.length > 0) {
          for (const ann of session.annotations) {
            if (!ann.selector) continue;
            callBrowserWebMcpTool(
              'voxmark_highlight_element',
              { selector: ann.selector, label: 'Agent Editing...', durationMs: 5000 },
              1500
            ).catch(() => {});

            const previewStyles = inferInstantPreviewStyles(
              ann.transcript || session.fullTranscript,
              ann.tagName
            );
            if (previewStyles) {
              callBrowserWebMcpTool(
                'voxmark_preview_styles',
                { selector: ann.selector, styles: previewStyles },
                1500
              )
                .then(() => {
                  const previewEvt = {
                    type: 'step',
                    sessionId: id,
                    kind: 'edit',
                    action: 'WebMCP Live Preview',
                    detail: `Applied instant 0ms style preview to ${ann.selector}`,
                    timestamp: new Date().toISOString()
                  };
                  session.steps.push(previewEvt);
                  if (activeJob && activeJob.sessionId === id) {
                    activeJob.steps.push(previewEvt);
                  }
                  broadcastEvent(previewEvt);
                })
                .catch(() => {});
            }
          }
        }

        // Execute connected coding agent asynchronously and stream status
        if (autoExecute) {
          agentRunner({
            prompt,
            targetDir,
            agent,
            conversationId,
            onEvent: (evt) => {
              const enriched = { ...evt, sessionId: id };
              if (evt.type === 'step') {
                session.steps.push(evt);
                if (activeJob && activeJob.sessionId === id) {
                  activeJob.steps.push(evt);
                }
                console.log(`   -> [${evt.action || 'Step'}] ${evt.detail || ''}`);
              } else if (evt.type === 'completed') {
                console.log(`   [ok] [Completed ${id}] ${evt.summary || ''}`);
              } else if (evt.type === 'failed' || evt.type === 'error') {
                console.log(`   [error] [Failed ${id}] ${evt.error || evt.summary || ''}`);
              }
              broadcastEvent(enriched);
            }
          }).then((result) => {
            session.status = result.ok ? 'completed' : 'failed';
            session.agentResult = {
              ok: result.ok,
              code: result.code,
              stdout: (result.stdout || '').slice(-2000)
            };
            if (activeJob && activeJob.sessionId === id) {
              activeJob = null;
            }
            fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2), 'utf8');
          });
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // 5. Serve standalone overlay script (/overlay.js)
    if (req.method === 'GET' && reqUrl.pathname === '/overlay.js') {
      const scriptPath = path.join(PKG_ROOT, 'extension', 'content.js');
      const code = fs.readFileSync(scriptPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(`window.__QUICK_FEEDBACK_BRIDGE__ = "${getBridgeOrigin()}";\n` + code);
      return;
    }

    // 6. Explicit /demo route (or / when --demo is passed or running inside voxmark repo itself without targetUrl)
    const isExplicitDemo =
      reqUrl.pathname === '/demo' ||
      (reqUrl.pathname === '/' && (demo || (isSelfRepo && !resolvedTargetUrl)));

    if (req.method === 'GET' && isExplicitDemo) {
      const demoHtmlPath = path.join(targetDir, 'demo', 'index.html');
      const fallbackDemoPath = path.join(PKG_ROOT, 'demo', 'index.html');
      const fileToServe = fs.existsSync(demoHtmlPath) ? demoHtmlPath : fallbackDemoPath;

      if (fs.existsSync(fileToServe)) {
        const html = injectOverlayIntoHtml(fs.readFileSync(fileToServe, 'utf8'), getBridgeOrigin());
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(html);
        return;
      }
    }

    // 7. Real App Serving: Proxy to upstream dev server OR serve static files from targetDir with /overlay.js injected
    if (!demo) {
      const tryServeStatic = () => {
        if (!isSelfRepo && (req.method === 'GET' || req.method === 'HEAD')) {
          const staticFile = resolveStaticFile(targetDir, reqUrl.pathname, explicitHtmlFile);
          if (staticFile) {
            const ext = path.extname(staticFile).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            if (ext === '.html' || ext === '.htm') {
              const rawHtml = fs.readFileSync(staticFile, 'utf8');
              const injected = injectOverlayIntoHtml(rawHtml, getBridgeOrigin());
              res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store'
              });
              res.end(req.method === 'HEAD' ? undefined : injected);
            } else {
              const stat = fs.statSync(staticFile);
              res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stat.size,
                'Cache-Control': 'no-cache'
              });
              if (req.method === 'HEAD') {
                res.end();
              } else {
                fs.createReadStream(staticFile).pipe(res);
              }
            }
            return true;
          }
        }
        return false;
      };

      const upstreamUrl =
        resolvedTargetUrl ||
        (!isSelfRepo ? detectListeningPortByCwd(targetDir, getActivePort(), { useCache: true }) : null);
      if (upstreamUrl) {
        resolvedTargetUrl = upstreamUrl;
        const canFallbackToStatic = !targetUrl;
        proxyHttpRequest(
          req,
          res,
          upstreamUrl,
          getBridgeOrigin(),
          canFallbackToStatic
            ? () => {
                resolvedTargetUrl = null;
                return tryServeStatic();
              }
            : null
        );
        return;
      }

      if (tryServeStatic()) {
        return;
      }
    }

    // 8. Final fallback for / when targetDir has neither a dev server nor an index.html
    if (req.method === 'GET' && reqUrl.pathname === '/') {
      const fallbackDemoPath = path.join(PKG_ROOT, 'demo', 'index.html');
      if (fs.existsSync(fallbackDemoPath)) {
        const html = injectOverlayIntoHtml(fs.readFileSync(fallbackDemoPath, 'utf8'), getBridgeOrigin());
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(html);
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Forward WebSocket upgrades (e.g. Vite/Next HMR) when proxying an upstream dev server
  server.on('upgrade', (req, socket, head) => {
    const upstreamUrl =
      resolvedTargetUrl ||
      (!demo && !isSelfRepo ? detectListeningPortByCwd(targetDir, getActivePort(), { useCache: true }) : null);
    forwardWebSocketUpgrade(req, socket, head, upstreamUrl);
  });

  return {
    server,
    sessions,
    storageDir,
    async start() {
      await listenOnAvailablePort(server, port, host);
      if (autoExecute && agentRunner === runCodingAgent) {
        warmUpCodingAgent({ targetDir, agent });
      }
      const activePort = getActivePort();
      if (!resolvedTargetUrl && !demo && !isSelfRepo) {
        resolvedTargetUrl = detectListeningPortByCwd(targetDir, activePort);
      }
      if (!resolvedTargetUrl && !demo && !isSelfRepo && shouldAutoStartApp) {
        const spawned = await spawnAppDevServer(targetDir, activePort, (detectedUrl) => {
          resolvedTargetUrl = detectedUrl;
        });
        spawnedDevChild = spawned.child;
        if (spawned.url) {
          resolvedTargetUrl = spawned.url;
        }
      }

      // Watch targetDir for source edits so static apps dynamically reload in browser
      if (!isSelfRepo && !fileWatcher) {
        try {
          fileWatcher = fs.watch(targetDir, { recursive: true }, (_eventType, filename) => {
            if (!filename) return;
            const norm = filename.replace(/\\/g, '/');
            if (
              norm.startsWith('.git/') ||
              norm.startsWith('node_modules/') ||
              norm.startsWith('.quick-feedback/')
            ) {
              return;
            }
            const ext = path.extname(norm).toLowerCase();
            if (!['.html', '.htm', '.css', '.scss', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) {
              return;
            }
            if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
            watchDebounceTimer = setTimeout(() => {
              broadcastEvent({ type: 'file_changed', file: norm });
            }, 180);
          });
          fileWatcher.on('error', () => {});
        } catch {}
      }

      const staticEntry = !isSelfRepo ? resolveStaticFile(targetDir, '/', explicitHtmlFile) : null;
      const hasStaticIndex = Boolean(staticEntry);
      const mode = demo
        ? 'demo'
        : resolvedTargetUrl
          ? 'proxy'
          : hasStaticIndex
            ? 'static'
            : 'demo';
      const boundUrl = `http://${host}:${activePort}`;
      if (openBrowser) {
        openUrlInBrowser(boundUrl);
      }
      return {
        host,
        port: activePort,
        url: boundUrl,
        targetUrl: resolvedTargetUrl,
        staticEntry,
        spawnedDevServer: Boolean(spawnedDevChild),
        mode
      };
    },
    stop() {
      return new Promise((resolve) => {
        if (watchDebounceTimer) {
          clearTimeout(watchDebounceTimer);
          watchDebounceTimer = null;
        }
        if (fileWatcher) {
          try {
            fileWatcher.close();
          } catch {}
          fileWatcher = null;
        }
        if (spawnedDevChild) {
          try {
            spawnedDevChild.kill('SIGTERM');
          } catch {}
          spawnedDevChild = null;
        }
        if (agentRunner === runCodingAgent) {
          closeWarmAgents();
        }
        for (const client of sseClients) {
          try {
            client.end();
          } catch {}
        }
        sseClients.clear();
        server.close(() => resolve());
      });
    }
  };
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeded ${MAX_BODY_BYTES} bytes limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
