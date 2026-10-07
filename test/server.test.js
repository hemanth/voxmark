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

test('createFeedbackServer serves real static app from targetDir on / with /overlay.js injected instead of demo page', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-real-static-'));
  fs.writeFileSync(
    path.join(tmpDir, 'index.html'),
    '<!DOCTYPE html><html><head><title>Real App</title></head><body><h1 id="real-heading">My Real App</h1><script src="/app.js"></script></body></html>',
    'utf8'
  );
  fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log("real app loaded");', 'utf8');

  const bridge = createFeedbackServer({
    port: 0,
    targetDir: tmpDir,
    autoExecute: false
  });
  const info = await bridge.start();

  try {
    assert.equal(info.mode, 'static');

    // GET / should serve the real app's index.html with /overlay.js injected, NOT the Orbital Telemetry demo
    const rootRes = await fetch(`${info.url}/`);
    assert.equal(rootRes.status, 200);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /My Real App/);
    assert.doesNotMatch(rootHtml, /Orbital Telemetry/);
    assert.match(rootHtml, new RegExp(`${info.url}/overlay\\.js`));

    // Static assets in targetDir should also be served
    const jsRes = await fetch(`${info.url}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(await jsRes.text(), /real app loaded/);

    // GET /demo should still serve the built-in demo sandbox
    const demoRes = await fetch(`${info.url}/demo`);
    assert.equal(demoRes.status, 200);
    const demoHtml = await demoRes.text();
    assert.match(demoHtml, /Orbital Telemetry/i);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createFeedbackServer reverse-proxies targetUrl dev server and auto-injects /overlay.js into HTML', async () => {
  const http = await import('node:http');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [1, 2, 3] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><div id="upstream-root">Upstream Dev Server</div></body></html>');
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-proxy-test-'));

  const bridge = createFeedbackServer({
    port: 0,
    targetDir: tmpDir,
    targetUrl: `http://127.0.0.1:${upstreamPort}`,
    autoExecute: false
  });
  const info = await bridge.start();

  try {
    assert.equal(info.mode, 'proxy');
    assert.equal(info.targetUrl, `http://127.0.0.1:${upstreamPort}`);

    const res = await fetch(`${info.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Upstream Dev Server/);
    assert.doesNotMatch(html, /Orbital Telemetry/);
    assert.match(html, new RegExp(`${info.url}/overlay\\.js`));

    const apiRes = await fetch(`${info.url}/api/data`);
    assert.equal(apiRes.status, 200);
    const data = await apiRes.json();
    assert.deepEqual(data, { items: [1, 2, 3] });
  } finally {
    await bridge.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createFeedbackServer discovers index.html inside nested subdirectories and auto-spawns npm run dev when configured', async () => {
  const tmpNestedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-nested-html-'));
  const subDir = path.join(tmpNestedDir, 'packages', 'web-ui');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'index.html'),
    '<!DOCTYPE html><html><body><div id="nested-html-app">Nested Directory App</div></body></html>',
    'utf8'
  );

  const staticBridge = createFeedbackServer({
    port: 0,
    targetDir: tmpNestedDir,
    autoExecute: false
  });
  const staticInfo = await staticBridge.start();

  try {
    assert.equal(staticInfo.mode, 'static');
    const res = await fetch(`${staticInfo.url}/`);
    const html = await res.text();
    assert.match(html, /Nested Directory App/);
    assert.match(html, new RegExp(`${staticInfo.url}/overlay\\.js`));
  } finally {
    await staticBridge.stop();
    fs.rmSync(tmpNestedDir, { recursive: true, force: true });
  }

  // Test auto-spawning npm run dev on a dynamic port and binding to it
  const tmpDevApp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-autodev-'));
  fs.writeFileSync(
    path.join(tmpDevApp, 'dev-server.js'),
    `
      const http = require('node:http');
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body><main id="spawned-dev">Auto-Spawned Dev App</main></body></html>');
      });
      srv.listen(0, '127.0.0.1', () => {
        console.log('Local: http://localhost:' + srv.address().port + '/');
      });
    `,
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpDevApp, 'package.json'),
    JSON.stringify({
      name: 'sample-dev-app',
      scripts: {
        dev: 'node dev-server.js'
      }
    }),
    'utf8'
  );

  const devBridge = createFeedbackServer({
    port: 0,
    targetDir: tmpDevApp,
    autoExecute: false,
    autoStartApp: true
  });
  const devInfo = await devBridge.start();

  try {
    assert.equal(devInfo.mode, 'proxy');
    assert.equal(devInfo.spawnedDevServer, true);
    assert.match(devInfo.targetUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${devInfo.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Auto-Spawned Dev App/);
    assert.match(html, new RegExp(`${devInfo.url}/overlay\\.js`));
  } finally {
    await devBridge.stop();
    fs.rmSync(tmpDevApp, { recursive: true, force: true });
  }
});

test('buildAgentPrompt resolves deep nested component hierarchies, sourceLocations, and props across multiple files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-nested-comp-'));
  try {
    const compDir = path.join(tmpDir, 'src', 'components', 'sidebar');
    fs.mkdirSync(compDir, { recursive: true });
    const cardFile = path.join(compDir, 'FilterCard.tsx');
    const sidebarFile = path.join(compDir, 'CaptionSidebar.tsx');

    fs.writeFileSync(
      cardFile,
      [
        'import React from "react";',
        'export function FilterCard({ activeFilter, onToggleFilter }) {',
        '  return (',
        '    <div className="filter-card" data-filter={activeFilter}>',
        '      <button id="apply-filter-btn" onClick={onToggleFilter}>Apply Filter</button>',
        '    </div>',
        '  );',
        '}'
      ].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      sidebarFile,
      [
        'import { FilterCard } from "./FilterCard";',
        'export function CaptionSidebar() {',
        '  return <aside className="sidebar-shell"><FilterCard activeFilter="tiktok" /></aside>;',
        '}'
      ].join('\n'),
      'utf8'
    );

    const prompt = buildAgentPrompt(
      {
        id: 'vm-nested-1',
        url: 'http://127.0.0.1:4747/',
        title: 'Studio App',
        fullTranscript: 'when I click Apply Filter, also reset the search input inside CaptionSidebar',
        annotations: [
          {
            number: 1,
            kind: 'select',
            selector: '#apply-filter-btn',
            tagName: 'button',
            componentName: '<FilterCard>',
            componentChain: ['<App>', '<CaptionSidebar>', '<FilterCard>'],
            sourceLocation: { fileName: 'src/components/sidebar/FilterCard.tsx', lineNumber: 5 },
            componentProps: { activeFilter: 'tiktok', onToggleFilter: 'fn(handleToggle)' },
            domHierarchy: 'main > aside.sidebar-shell > div.filter-card > button#apply-filter-btn',
            nestedChildren: [],
            transcript: 'when I click Apply Filter, also reset the search input inside CaptionSidebar'
          }
        ]
      },
      { targetDir: tmpDir }
    );

    assert.match(prompt, /\*\*Component Hierarchy\*\*: `<App> > <CaptionSidebar> > <FilterCard>`/);
    assert.match(prompt, /\*\*Component Source Location\*\*: `src\/components\/sidebar\/FilterCard\.tsx:5`/);
    assert.match(prompt, /\*\*Live Component Props \/ Handlers\*\*: `\{"activeFilter":"tiktok","onToggleFilter":"fn\(handleToggle\)"\}`/);
    assert.match(prompt, /FilterCard\.tsx/);
    assert.match(prompt, /CaptionSidebar\.tsx/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
