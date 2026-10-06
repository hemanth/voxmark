import { EventEmitter } from 'node:events';
import { createFeedbackServer } from './server.js';
import { buildAgentPrompt } from './prompt-builder.js';
import { runCodingAgent, warmUpCodingAgent } from './agent-runner.js';

/**
 * Start a Voxmark voice + DOM annotation bridge.
 *
 * @param {string|object} [input] - Target directory path or options object
 * @param {object} [options] - Flat options `{ port, dir, agent, autoExecute, conversationId }`
 */
export default async function voxmark(input = {}, options = {}) {
  const opts =
    typeof input === 'string'
      ? { ...options, dir: input }
      : { ...input, ...options };

  const events = new EventEmitter();
  const bridge = createFeedbackServer({
    port: opts.port ?? Number(process.env.VOXMARK_PORT || process.env.QF_PORT || 4747),
    targetDir: opts.dir || opts.targetDir || process.cwd(),
    agent: opts.agent || process.env.VOXMARK_AGENT || process.env.QF_AGENT || 'agy',
    autoExecute: opts.autoExecute ?? true,
    conversationId: opts.conversation || opts.conversationId || null,
    customAgentRunner: opts.customAgentRunner || null,
    onFeedbackReceived: (session) => {
      events.emit('feedback', session);
      if (typeof opts.onFeedback === 'function') opts.onFeedback(session);
      if (typeof opts.onFeedbackReceived === 'function') opts.onFeedbackReceived(session);
    }
  });

  const info = await bridge.start();
  return {
    url: info.url,
    port: info.port,
    server: bridge.server,
    on: (event, handler) => {
      events.on(event, handler);
      return this;
    },
    stop: () => bridge.stop()
  };
}

export { voxmark, createFeedbackServer, buildAgentPrompt, runCodingAgent, warmUpCodingAgent };
