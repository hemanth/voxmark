#!/usr/bin/env node
import path from 'node:path';
import { createFeedbackServer } from '../src/server.js';

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.VOXMARK_PORT || process.env.QF_PORT || 4747),
    targetDir: process.cwd(),
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
    else if ((arg === '--agent' || arg === '-a') && argv[i + 1]) opts.agent = argv[++i];
    else if ((arg === '--conversation' || arg === '-c') && argv[i + 1]) opts.conversationId = argv[++i];
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
  voxmark (vm) — Live Voice & WebMCP DOM Annotation Bridge for Coding Agents

  Usage:
    voxmark [options]

  Options:
    -d, --dir <path>           Target project directory for the agent to edit (default: cwd)
    -a, --agent <name>         Coding agent CLI to execute (default: agy)
    -c, --conversation <id>    Continue a specific Antigravity conversation ID
    -p, --port <number>        Bridge port (default: 4747)
    --no-exec                  Save feedback sessions without auto-running the agent
    --demo                     Print the built-in interactive demo playground URL
    -h, --help                 Show this help message
`);
  process.exit(0);
}

const bridge = createFeedbackServer({
  port: opts.port,
  targetDir: opts.targetDir,
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

console.log(`
┌──────────────────────────────────────────────────────────────────────┐
│  VOXMARK — Live Voice & WebMCP DOM Annotation Bridge                 │
├──────────────────────────────────────────────────────────────────────┤
│  Bridge URL:     ${info.url.padEnd(50)}│
│  Target Repo:    ${opts.targetDir.slice(0, 50).padEnd(50)}│
│  Connected CLI:  ${(opts.autoExecute ? `${opts.agent} (auto-execute enabled)` : 'Queue-only (--no-exec)').padEnd(50)}│
│  Demo Sandbox:   ${`${info.url}/demo`.padEnd(50)}│
│  Chrome Ext:     ${extDir.slice(0, 50).padEnd(50)}│
└──────────────────────────────────────────────────────────────────────┘

Press Alt+F on any localhost page (or open ${info.url}/demo) to annotate and speak.
`);
