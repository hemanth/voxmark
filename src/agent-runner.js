import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the executable path for the coding agent (`agy` by default).
 */
export function resolveAgentBinary(agentName = 'agy') {
  if (agentName === 'agy') {
    const localBin = path.join(os.homedir(), '.local', 'bin', 'agy');
    if (existsSync(localBin)) return localBin;
  }
  return agentName;
}

function cleanQuoted(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/^"+|"+$/g, '').trim();
}

/**
 * Creates a fast TMPDIR that prevents IDE-only MCP proxy scripts
 * (`mcp_proxy_bundle.js`) from sleeping 20s waiting on ENOENT sockets
 * when running `agy` headlessly.
 */
function prepareFastTmpDir() {
  const fastTmp = path.join(os.tmpdir(), 'voxmark-fast-tmp');
  try {
    fs.mkdirSync(fastTmp, { recursive: true });
    const proxyIds = [
      'dataAgentKit-antigravityide',
      'notebooks-antigravityide',
      'visualization-antigravityide'
    ];
    for (const id of proxyIds) {
      fs.mkdirSync(path.join(fastTmp, `datacloud-mcp-${id}.sock`), { recursive: true });
    }
  } catch {}
  return fastTmp;
}

const warmWorkers = new Map();

function getOrSpawnWarmAgyWorker({ bin, targetDir, model, autoApprove, conversationId }) {
  const key = `${bin}::${targetDir}`;
  const existing = warmWorkers.get(key);
  if (existing && !existing.closed && existing.child && !existing.child.killed) {
    return existing;
  }

  const fastTmp = prepareFastTmpDir();
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--mode',
    'accept-edits',
    '--disable-slash-commands',
    '--model',
    model,
    '--effort',
    'low'
  ];
  if (autoApprove) {
    args.push('--dangerously-skip-permissions');
  }
  if (conversationId) {
    args.push('--conversation', conversationId);
  }

  const child = spawn(bin, args, {
    cwd: targetDir,
    env: {
      ...process.env,
      TMPDIR: fastTmp,
      PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const worker = {
    key,
    child,
    conversationId: conversationId || null,
    closed: false,
    busy: false,
    stdoutBuf: '',
    currentTurn: null
  };

  child.stdout.on('data', (chunk) => {
    worker.stdoutBuf += chunk.toString();
    const lines = worker.stdoutBuf.split('\n');
    worker.stdoutBuf = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('{')) {
        try {
          const evt = JSON.parse(line);
          if (evt.event === 'init' && evt.conversation_id) {
            worker.conversationId = evt.conversation_id;
            if (worker.currentTurn) {
              worker.currentTurn.onInit(evt.conversation_id);
            }
          } else if (evt.event === 'step_update' && evt.step_update) {
            const su = evt.step_update;
            if (su.step_type === 'agent_response' && su.text_delta && worker.currentTurn) {
              worker.currentTurn.finalResponse += su.text_delta;
            }
          } else if (evt.event === 'result' && evt.result) {
            if (worker.currentTurn) {
              const turn = worker.currentTurn;
              worker.currentTurn = null;
              worker.busy = false;
              const resp = evt.result.response || turn.finalResponse || '';
              const isErr = evt.result.status === 'ERROR' || Boolean(evt.result.error);
              turn.finish({
                ok: !isErr,
                code: isErr ? 1 : 0,
                summary: resp.trim() || evt.result.error || 'Changes applied.'
              });
            }
          }
          continue;
        } catch {}
      }

      if (worker.currentTurn) {
        worker.currentTurn.finalResponse += line + '\n';
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    if (worker.currentTurn) {
      worker.currentTurn.stderr += chunk.toString();
    }
  });

  child.on('error', (err) => {
    worker.closed = true;
    warmWorkers.delete(key);
    if (worker.currentTurn) {
      const turn = worker.currentTurn;
      worker.currentTurn = null;
      worker.busy = false;
      turn.fail(err);
    }
  });

  child.on('close', (code) => {
    worker.closed = true;
    warmWorkers.delete(key);
    if (worker.currentTurn) {
      const turn = worker.currentTurn;
      worker.currentTurn = null;
      worker.busy = false;
      const ok = code === 0;
      turn.finish({
        ok,
        code: code ?? -1,
        summary: turn.finalResponse.trim() || turn.stderr.trim().slice(-400) || 'Changes applied.'
      });
    }
  });

  warmWorkers.set(key, worker);
  return worker;
}

/**
 * Pre-warms the persistent `agy` stream-json process in the background so that
 * when the user submits voice/DOM annotations, there is 0ms cold-start latency.
 */
export function warmUpCodingAgent({
  targetDir = process.cwd(),
  agent = 'agy',
  model = process.env.QF_MODEL || 'gemini-3.8-flash-low'
} = {}) {
  const bin = resolveAgentBinary(agent);
  const isAgy = agent === 'agy' || bin.endsWith('/agy');
  if (!isAgy) return;

  const worker = getOrSpawnWarmAgyWorker({
    bin,
    targetDir,
    model,
    autoApprove: true,
    conversationId: null
  });

  if (!worker.busy && !worker.warmedUp) {
    worker.warmedUp = true;
    worker.busy = true;
    worker.currentTurn = {
      finalResponse: '',
      stderr: '',
      onInit: () => {},
      finish: () => {},
      fail: () => {}
    };
    try {
      worker.child.stdin.write(
        JSON.stringify({
          event: 'user',
          message: {
            content:
              'Warmup ready check: do not call any tools, reply with the single word READY.'
          }
        }) + '\n'
      );
    } catch {
      worker.busy = false;
      worker.currentTurn = null;
    }
  }
}

export function closeWarmAgents() {
  for (const [, worker] of warmWorkers) {
    worker.closed = true;
    try {
      worker.child.kill('SIGTERM');
    } catch {}
  }
  warmWorkers.clear();
}

/**
 * Executes the coding agent (`agy`, `claude`, or custom command) with the
 * generated feedback prompt in the target project directory, streaming live
 * thinking and tool-call steps to `onEvent`.
 */
export function runCodingAgent({
  prompt,
  targetDir = process.cwd(),
  agent = 'agy',
  model = process.env.QF_MODEL || 'gemini-3.8-flash-low',
  conversationId = null,
  autoApprove = true,
  onEvent = () => {}
}) {
  const bin = resolveAgentBinary(agent);
  const isAgy = agent === 'agy' || bin.endsWith('/agy');

  if (isAgy) {
    return runWarmAgyTurn({
      bin,
      prompt,
      targetDir,
      model,
      conversationId,
      autoApprove,
      onEvent
    });
  }

  return new Promise((resolve) => {
    let args = [];
    if (agent === 'claude') {
      args = ['-p', prompt];
      if (autoApprove) args.push('--dangerously-skip-permissions');
    } else {
      args = [prompt];
    }

    onEvent({
      type: 'started',
      agent: bin,
      targetDir,
      message: 'Agent connected — applying DOM & style changes...',
      timestamp: new Date().toISOString()
    });

    const child = spawn(bin, args, {
      cwd: targetDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      onEvent({ type: 'error', error: err.message, timestamp: new Date().toISOString() });
      resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
    child.on('close', (code) => {
      const ok = code === 0;
      const summary = stdout.trim() || stderr.trim().slice(-400) || 'Changes applied.';
      onEvent({
        type: ok ? 'completed' : 'failed',
        code,
        summary,
        timestamp: new Date().toISOString()
      });
      resolve({ ok, code, stdout: summary, stderr });
    });
  });
}

function runWarmAgyTurn({
  bin,
  prompt,
  targetDir,
  model,
  conversationId,
  autoApprove,
  onEvent
}) {
  return new Promise((resolve) => {
    let worker = getOrSpawnWarmAgyWorker({
      bin,
      targetDir,
      model,
      autoApprove,
      conversationId
    });

    // If the warm worker is still finishing its warmup ping or a prior turn, wait briefly or spawn dedicated
    const dispatchTurn = () => {
      if (worker.closed || !worker.child || worker.child.killed) {
        worker = getOrSpawnWarmAgyWorker({
          bin,
          targetDir,
          model,
          autoApprove,
          conversationId
        });
      }

      onEvent({
        type: 'started',
        agent: bin,
        targetDir,
        message: 'Agent connected — applying DOM & style changes...',
        timestamp: new Date().toISOString()
      });

      let transcriptTimer = null;
      let seenTranscriptLines = 0;

      function getTranscriptPath(convId) {
        return path.join(
          os.homedir(),
          '.gemini',
          'antigravity-cli',
          'brain',
          convId,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
      }

      function flushTranscript(convId) {
        if (!convId) return;
        const transcriptPath = getTranscriptPath(convId);
        if (!existsSync(transcriptPath)) return;
        try {
          const content = fs.readFileSync(transcriptPath, 'utf8');
          const lines = content.split('\n').filter((l) => l.trim().length > 0);
          while (seenTranscriptLines < lines.length) {
            const line = lines[seenTranscriptLines++];
            try {
              const step = JSON.parse(line);
              emitTranscriptStepEvents(step, onEvent);
            } catch {}
          }
        } catch {}
      }

      function startTranscriptWatcher(convId) {
        if (transcriptTimer || !convId) return;
        const transcriptPath = getTranscriptPath(convId);
        if (existsSync(transcriptPath)) {
          try {
            const existing = fs
              .readFileSync(transcriptPath, 'utf8')
              .split('\n')
              .filter((l) => l.trim().length > 0);
            seenTranscriptLines = existing.length;
          } catch {}
        }
        transcriptTimer = setInterval(() => flushTranscript(convId), 120);
      }

      function stopTranscriptWatcher(convId) {
        if (transcriptTimer) {
          clearInterval(transcriptTimer);
          transcriptTimer = null;
        }
        flushTranscript(convId);
      }

      if (worker.conversationId) {
        startTranscriptWatcher(worker.conversationId);
        onEvent({
          type: 'step',
          action: 'Session ready',
          detail: 'Applying pre-resolved DOM & CSS edits...',
          conversationId: worker.conversationId,
          timestamp: new Date().toISOString()
        });
      }

      worker.busy = true;
      worker.currentTurn = {
        finalResponse: '',
        stderr: '',
        onInit: (convId) => {
          startTranscriptWatcher(convId);
          onEvent({
            type: 'step',
            action: 'Session ready',
            detail: 'Applying pre-resolved DOM & CSS edits...',
            conversationId: convId,
            timestamp: new Date().toISOString()
          });
        },
        finish: ({ ok, code, summary }) => {
          stopTranscriptWatcher(worker.conversationId);
          onEvent({
            type: ok ? 'completed' : 'failed',
            code,
            summary,
            conversationId: worker.conversationId,
            timestamp: new Date().toISOString()
          });
          resolve({
            ok,
            code,
            conversationId: worker.conversationId,
            stdout: summary,
            stderr: ''
          });
        },
        fail: (err) => {
          stopTranscriptWatcher(worker.conversationId);
          onEvent({
            type: 'error',
            error: err.message,
            timestamp: new Date().toISOString()
          });
          resolve({
            ok: false,
            code: -1,
            stdout: '',
            stderr: err.message
          });
        }
      };

      try {
        worker.child.stdin.write(
          JSON.stringify({
            event: 'user',
            message: { content: prompt }
          }) + '\n'
        );
      } catch (err) {
        worker.busy = false;
        const turn = worker.currentTurn;
        worker.currentTurn = null;
        if (turn) turn.fail(err);
      }
    };

    if (worker.busy) {
      const waitTimer = setInterval(() => {
        if (!worker.busy || worker.closed) {
          clearInterval(waitTimer);
          dispatchTurn();
        }
      }, 80);
    } else {
      dispatchTurn();
    }
  });
}

function emitTranscriptStepEvents(step, onEvent) {
  if (!step || step.source !== 'MODEL') return;

  if (step.thinking && typeof step.thinking === 'string') {
    const firstSentence = step.thinking
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s+/)[0];
    if (firstSentence) {
      onEvent({
        type: 'step',
        kind: 'thinking',
        action: 'Thinking',
        detail: firstSentence.slice(0, 120),
        timestamp: new Date().toISOString()
      });
    }
  }

  if (Array.isArray(step.tool_calls)) {
    for (const tc of step.tool_calls) {
      const args = tc.args || {};
      const action = cleanQuoted(args.toolAction) || cleanQuoted(args.toolSummary) || tc.name;
      const targetFile = cleanQuoted(args.TargetFile) || cleanQuoted(args.AbsolutePath);
      const description =
        cleanQuoted(args.Description) ||
        cleanQuoted(args.Instruction) ||
        cleanQuoted(args.CommandLine);
      const shortFile = targetFile ? path.basename(targetFile) : '';

      let detail = '';
      if (shortFile && description) {
        detail = `${shortFile} — ${description}`;
      } else if (shortFile) {
        detail = shortFile;
      } else if (description) {
        detail = description;
      }

      onEvent({
        type: 'step',
        kind:
          tc.name === 'replace_file_content' || tc.name === 'write_to_file' ? 'edit' : 'tool',
        tool: tc.name,
        action,
        file: shortFile || null,
        detail: detail.slice(0, 140),
        timestamp: new Date().toISOString()
      });
    }
  }
}
