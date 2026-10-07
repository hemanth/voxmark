#!/usr/bin/env node
import path from 'node:path';
import { createFeedbackServer } from '../src/server.js';

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.VOXMARK_PORT || process.env.QF_PORT || 4747),
    targetDir: process.cwd(),
    targetUrl: process.env.VOXMARK_URL || process.env.QF_URL || null,
    agent: process.env.VOXMARK_AGENT || process.env.QF_AGENT || 'agy',
    autoExecute: true,
    conversationId: null,
    demo: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--demo') opts.demo = true;
    else if (arg === '--no-exec' || arg === '--queue-only') opts.autoExecute = false;
    else if ((arg === '--port' || arg === '-p') && argv[i + 1]) opts.port = Number(argv[++i]);
    else if ((arg === '--dir' || arg === '-d') && argv[i + 1]) opts.targetDir = path.resolve(argv[++i]);
    else if ((arg === '--url' || arg === '-u') && argv[i + 1]) opts.targetUrl = argv[++i];
    else if ((arg === '--agent' || arg === '-a') && argv[i + 1]) opts.agent = argv[++i];
    else if ((arg === '--conversation' || arg === '-c') && argv[i + 1]) opts.conversationId = argv[++i];
    else if (!arg.startsWith('-')) {
      if (/^https?:\/\//i.test(arg)) {
        opts.targetUrl = arg;
      } else if (/^\d+$/.test(arg)) {
        opts.port = Number(arg);
      } else {
        opts.targetDir = path.resolve(arg);
      }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
  voxmark (vm) — Live Voice & WebMCP DOM Annotation Bridge for Coding Agents

  Usage:
    voxmark [url|dir] [options]

  Options:
    -u, --url <url>            Upstream dev server URL to proxy & inject overlay (auto-detected)
    -d, --dir <path>           Target project directory for the agent to edit (default: cwd)
    -a, --agent <name>         Coding agent CLI to execute (default: agy)
    -c, --conversation <id>    Continue a specific Antigravity conversation ID
    -p, --port <number>        Bridge port (default: 4747)
    --no-exec                  Save feedback sessions without auto-running the agent
    --demo                     Serve the built-in interactive demo sandbox on /
    -h, --help                 Show this help message
`);
  process.exit(0);
}

const bridge = createFeedbackServer({
  port: opts.port,
  targetDir: opts.targetDir,
  targetUrl: opts.targetUrl,
  demo: opts.demo,
  agent: opts.agent,
  autoExecute: opts.autoExecute,
  conversationId: opts.conversationId,
  onFeedbackReceived: (session) => {
    console.log(`\n[voxmark] Received session ${session.id}`);
    console.log(`   URL:         ${session.url}`);
    if (session.fullTranscript) {
      console.log(`   Transcript:  "${session.fullTranscript}"`);
    }
    console.log(`   Annotations: ${session.annotations.length} element(s) bound`);
    session.annotations.forEach((a, idx) => {
      console.log(`     #${idx + 1} [${a.kind}] ${a.selector} -> "${a.transcript || '(see full transcript)'}"`);
    });
    console.log(`   Saved to:    ${path.join(opts.targetDir, '.quick-feedback', 'latest.md')}`);
    if (opts.autoExecute) {
      console.log(`[voxmark] Dispatching to agent (${opts.agent}) in ${opts.targetDir}...`);
    }
  }
});

const info = await bridge.start();
const extDir = path.resolve(new URL('../extension', import.meta.url).pathname);
const appModeDesc =
  info.mode === 'proxy'
    ? `Proxying ${info.targetUrl} (overlay auto-injected)`
    : info.mode === 'static'
      ? `Serving static app in ${path.basename(opts.targetDir)} (overlay auto-injected)`
      : `Demo Sandbox (${info.url}/demo)`;

console.log(`
┌──────────────────────────────────────────────────────────────────────┐
│  VOXMARK — Live Voice & WebMCP DOM Annotation Bridge                 │
├──────────────────────────────────────────────────────────────────────┤
│  Open App URL:   ${info.url.padEnd(50)}│
│  App Target:     ${appModeDesc.slice(0, 50).padEnd(50)}│
│  Target Repo:    ${opts.targetDir.slice(0, 50).padEnd(50)}│
│  Connected CLI:  ${(opts.autoExecute ? `${opts.agent} (auto-execute enabled)` : 'Queue-only (--no-exec)').padEnd(50)}│
│  Demo Sandbox:   ${`${info.url}/demo`.padEnd(50)}│
│  Chrome Ext:     ${extDir.slice(0, 50).padEnd(50)}│
└──────────────────────────────────────────────────────────────────────┘

Open ${info.url} in your browser and press Alt+F to annotate and speak.
`);
