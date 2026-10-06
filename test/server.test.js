import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgentPrompt } from '../src/prompt-builder.js';
import { createFeedbackServer } from '../src/server.js';

test('buildAgentPrompt produces structured markdown with voice transcript, DOM selectors, and pre-resolved source lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-prompt-test-'));
  try {
    const demoDir = path.join(tmpDir, 'demo');
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(
      path.join(demoDir, 'index.html'),
      [
        '<!DOCTYPE html>',
        '<html><head><style>',
        '  #cta-button { background: #3b82f6; color: #fff; }',
        '</style></head><body>',
        '  <header id="hero-header">Orbital Telemetry Console</header>',
        '  <button id="cta-button">Deploy Stream</button>',
        '</body></html>'
      ].join('\n'),
      'utf8'
    );

    const prompt = buildAgentPrompt(
      {
        id: 'vm-100',
        url: 'http://localhost:4747/demo',
        title: 'Dashboard',
        viewport: { width: 1440, height: 900 },
        fullTranscript: 'center this header and make the CTA button green and animate',
        annotations: [
          {
            number: 1,
            kind: 'draw',
            selector: '#hero-header',
            tagName: 'header',
            componentName: '<HeroHeader>',
            textPreview: 'Orbital Telemetry Console',
            transcript: 'center this header',
            bounds: { x: 100, y: 48, width: 800, height: 90 },
            computedStyles: { textAlign: 'left', padding: '24px' },
            htmlSnippet: '<header id="hero-header">Orbital Telemetry Console</header>'
          },
          {
            number: 2,
            kind: 'box',
            selector: '#cta-button',
            tagName: 'button',
            transcript: 'make the CTA button green and animate',
            bounds: { x: 650, y: 320, width: 140, height: 42 },
            computedStyles: { backgroundColor: 'rgb(59, 130, 246)' },
            htmlSnippet: '<button id="cta-button">Deploy Stream</button>'
          }
        ]
      },
      { targetDir: tmpDir }
    );

    assert.match(prompt, /# Live UI Feedback Request \(vm-100\)/);
    assert.match(prompt, /center this header and make the CTA button green and animate/);
    assert.match(prompt, /### #1 — \[DRAW\] `#hero-header`/);
    assert.match(prompt, /`<HeroHeader>`/);
    assert.match(prompt, /### #2 — \[BOX\] `#cta-button`/);
    assert.match(prompt, /Pre-Resolved Source Lines/);
    assert.match(prompt, /3:   #cta-button \{ background: #3b82f6; color: #fff; \}/);
    assert.doesNotMatch(prompt, /Screenshot/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createFeedbackServer writes latest.md, triggers agent runner, and exposes WebMCP server card without screenshots', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-'));
  let agentCalledWith = null;

  const bridge = createFeedbackServer({
    port: 0,
    targetDir: tmpDir,
    agent: 'agy',
    autoExecute: true,
    customAgentRunner: async (params) => {
      agentCalledWith = params;
      params.onEvent({ type: 'started', targetDir: tmpDir });
      params.onEvent({ type: 'completed', code: 0, summary: 'Updated #hero-header and #cta-button' });
      return { ok: true, code: 0, stdout: 'Fixed!', stderr: '' };
    }
  });

  const info = await bridge.start();

  try {
    // 1. Health check
    const healthRes = await fetch(`${info.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.agent, 'agy');

    // 2. Overlay script check
    const overlayRes = await fetch(`${info.url}/overlay.js`);
    assert.equal(overlayRes.status, 200);
    const overlayText = await overlayRes.text();
    assert.match(overlayText, /__QUICK_FEEDBACK_LOADED__/);
    assert.doesNotMatch(overlayText, /Snapshotting annotated screen/);

    // 3. Submit feedback with voice + DOM annotation (no screenshot)
    const fbRes = await fetch(`${info.url}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://localhost:4747/demo',
        title: 'Demo',
        viewport: { width: 1280, height: 800 },
        fullTranscript: 'center this title and make it glow',
        annotations: [
          {
            number: 1,
            kind: 'draw',
            selector: '#hero-title',
            tagName: 'h1',
            transcript: 'center this title and make it glow',
            bounds: { x: 50, y: 50, width: 400, height: 40 },
            computedStyles: { textAlign: 'left' },
            htmlSnippet: '<h1 id="hero-title">Orbital Telemetry Console</h1>'
          }
        ]
      })
    });

    assert.equal(fbRes.status, 200);
    const fbJson = await fbRes.json();
    assert.equal(fbJson.ok, true);
    assert.equal(fbJson.screenshotPath, undefined);
    assert.equal(fs.existsSync(path.join(tmpDir, '.quick-feedback', 'latest.md')), true);

    // Wait briefly for async agent runner
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(agentCalledWith);
    assert.equal(agentCalledWith.targetDir, tmpDir);
    assert.match(agentCalledWith.prompt, /#hero-title/);

    // 4. WebMCP sync + SEP-1649 MCP Server Card
    const syncRes = await fetch(`${info.url}/api/webmcp/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://localhost:4747/demo',
        title: 'Voxmark Demo',
        tools: [
          { name: 'voxmark_inspect_dom', description: 'Inspect DOM by selector', source: 'voxmark' },
          { name: 'get_telemetry_metrics', description: 'Read orbital telemetry metrics', source: 'app' }
        ]
      })
    });
    assert.equal(syncRes.status, 200);

    const cardRes = await fetch(`${info.url}/.well-known/mcp/server-card.json`);
    assert.equal(cardRes.status, 200);
    const card = await cardRes.json();
    assert.equal(card.name, 'voxmark-webmcp-bridge');
    assert.equal(card.tools.length, 2);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
