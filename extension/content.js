(() => {
  if (window.__QUICK_FEEDBACK_LOADED__) {
    if (typeof window.__QUICK_FEEDBACK_TOGGLE__ === 'function') {
      window.__QUICK_FEEDBACK_TOGGLE__();
    }
    return;
  }
  window.__QUICK_FEEDBACK_LOADED__ = true;

  const BRIDGE_URL = window.__QUICK_FEEDBACK_BRIDGE__ || 'http://127.0.0.1:4747';

  // --- Clean 1.5px Vector SVG Icons (Zero Emojis) ---
  const ICONS = {
    mic: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
    micOff: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
    select: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>`,
    draw: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    box: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>`,
    arrow: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>`,
    send: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    code: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    step: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/></svg>`,
    alert: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`
  };

  // --- State ---
  let isRecording = false;
  let activeTool = 'select'; // 'select' | 'draw' | 'box' | 'arrow'
  let bridgeOnline = false;

  let annotations = [];
  let selectedAnnotation = null;
  let flushingAnnotation = null; // Holds previous annotation during ASR stop/flush transition
  let flushTimeout = null;
  let currentStroke = null;
  let hoveredElement = null;

  // Speech recognition & 0ms WebAudio meter
  let recognition = null;
  let isMicListening = false;
  let audioCtx = null;
  let analyser = null;
  let mediaStream = null;
  let rafMeterId = null;

  // Live Agent Execution Panel state
  let agentJob = null;
  let elapsedTimer = null;

  // --- Host & Shadow DOM ---
  const host = document.createElement('div');
  host.id = 'voxmark-root';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; }
    
    #vm-canvas {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 10;
    }
    #vm-canvas.active {
      pointer-events: auto;
      cursor: crosshair;
    }

    #vm-hover-box {
      position: fixed;
      pointer-events: none;
      border: 1.5px solid rgba(56, 189, 248, 0.85);
      background: rgba(56, 189, 248, 0.05);
      border-radius: 4px;
      z-index: 9;
      display: none;
      transition: left 0.04s ease-out, top 0.04s ease-out, width 0.04s ease-out, height 0.04s ease-out;
    }
    #vm-hover-tag {
      position: absolute;
      top: -21px;
      left: -1px;
      background: #09090b;
      color: #38bdf8;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      white-space: nowrap;
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 4px 10px rgba(0,0,0,0.35);
    }

    /* Persistent Element Lock Frames & Badges */
    #vm-overlays {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 11;
    }

    .vm-element-lock {
      position: fixed;
      pointer-events: none;
      border: 1.5px dashed rgba(244, 63, 94, 0.65);
      background: rgba(244, 63, 94, 0.03);
      border-radius: 4px;
    }
    .vm-element-lock.focused {
      border-style: solid;
      border-color: #f43f5e;
      background: rgba(244, 63, 94, 0.06);
      box-shadow: 0 0 0 1px rgba(244, 63, 94, 0.25);
    }

    .vm-pin-card {
      position: fixed;
      display: flex;
      flex-direction: column;
      gap: 5px;
      background: rgba(9, 9, 11, 0.96);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      color: #f4f4f5;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 10px;
      padding: 7px 9px;
      width: 270px;
      box-shadow: 0 14px 34px rgba(0,0,0,0.55);
      pointer-events: auto;
      z-index: 12;
    }
    .vm-pin-card.focused {
      border-color: #f43f5e;
      box-shadow: 0 14px 34px rgba(0,0,0,0.6), 0 0 0 1px rgba(244, 63, 94, 0.35);
    }

    .vm-pin-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .vm-pin-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .vm-pin-num {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      background: #f43f5e;
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10.5px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      flex-shrink: 0;
    }
    .vm-pin-selector {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
      color: #38bdf8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .vm-pin-del {
      color: #71717a;
      background: none;
      border: none;
      padding: 2px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
    }
    .vm-pin-del:hover { color: #f87171; }

    .vm-pin-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 5px 8px;
      color: #fafafa;
      font-size: 11.5px;
      outline: none;
    }
    .vm-pin-input:focus {
      border-color: #f43f5e;
      background: rgba(255, 255, 255, 0.09);
    }
    .vm-pin-input::placeholder {
      color: #71717a;
    }

    /* Floating Dock */
    #vm-dock {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      user-select: none;
    }

    .vm-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(9, 9, 11, 0.96);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      padding: 6px 8px;
      color: #f4f4f5;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0,0,0,0.5);
      font-size: 12px;
    }

    .vm-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #52525b;
      flex-shrink: 0;
      margin: 0 4px;
    }
    .vm-status-dot.online { background: #10b981; box-shadow: 0 0 8px rgba(16,185,129,0.8); }

    /* Live 4-bar Equalizer (0ms WebAudio latency) */
    .vm-eq {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 14px;
      padding: 0 4px;
    }
    .vm-eq-bar {
      width: 2.5px;
      height: 3px;
      background: #f43f5e;
      border-radius: 2px;
      transition: height 0.04s linear;
    }

    .vm-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      color: #d4d4d8;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.12s ease;
      white-space: nowrap;
    }
    .vm-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }
    .vm-btn.active {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
      color: #fff;
    }
    .vm-btn.primary {
      background: #f4f4f5;
      border-color: #ffffff;
      color: #09090b;
      font-weight: 600;
    }
    .vm-btn.primary:hover {
      background: #ffffff;
    }

    .vm-divider {
      width: 1px;
      height: 18px;
      background: rgba(255, 255, 255, 0.12);
      margin: 0 2px;
    }

    .vm-kbd {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.09);
      color: #a1a1aa;
    }

    /* Live Agent Activity Card */
    #vm-agent-panel {
      display: none;
      flex-direction: column;
      gap: 10px;
      background: rgba(9, 9, 11, 0.97);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 12px;
      padding: 12px 14px;
      width: min(540px, 92vw);
      color: #f4f4f5;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65);
      font-size: 12px;
    }
    #vm-agent-panel.visible {
      display: flex;
    }
    #vm-agent-panel.done {
      border-color: rgba(16, 185, 129, 0.55);
    }
    #vm-agent-panel.error {
      border-color: rgba(244, 63, 94, 0.55);
    }

    .vm-agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 8px;
    }
    .vm-agent-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 12px;
      color: #fafafa;
    }
    .vm-agent-timer {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #a1a1aa;
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 7px;
      border-radius: 4px;
    }

    .vm-spinner {
      width: 13px;
      height: 13px;
      border: 1.8px solid rgba(255, 255, 255, 0.2);
      border-top-color: #f4f4f5;
      border-radius: 50%;
      animation: vmSpin 0.7s linear infinite;
      flex-shrink: 0;
    }
    .vm-spinner.done {
      border: none;
      width: auto;
      height: auto;
      color: #10b981;
      animation: none;
    }
    @keyframes vmSpin { to { transform: rotate(360deg); } }

    .vm-targets-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .vm-target-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      max-width: 100%;
    }
    .vm-target-chip code {
      color: #38bdf8;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
    }
    .vm-target-chip span {
      color: #d4d4d8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 220px;
    }

    .vm-steps-feed {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-height: 130px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 8px;
      padding: 8px 10px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .vm-step-row {
      display: flex;
      align-items: center;
      gap: 7px;
      color: #a1a1aa;
      line-height: 1.35;
    }
    .vm-step-row.latest {
      color: #f4f4f5;
      font-weight: 500;
    }
    .vm-step-row.edit {
      color: #34d399;
    }
    .vm-step-action {
      color: #e4e4e7;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .vm-step-row.edit .vm-step-action {
      color: #10b981;
    }
  `;
  shadow.appendChild(style);

  // --- DOM Elements inside Shadow ---
  const hoverBox = document.createElement('div');
  hoverBox.id = 'vm-hover-box';
  const hoverTag = document.createElement('span');
  hoverTag.id = 'vm-hover-tag';
  hoverBox.appendChild(hoverTag);
  shadow.appendChild(hoverBox);

  const canvas = document.createElement('canvas');
  canvas.id = 'vm-canvas';
  shadow.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const overlaysContainer = document.createElement('div');
  overlaysContainer.id = 'vm-overlays';
  shadow.appendChild(overlaysContainer);

  const dock = document.createElement('div');
  dock.id = 'vm-dock';
  dock.innerHTML = `
    <div id="vm-agent-panel">
      <div class="vm-agent-header">
        <div class="vm-agent-title">
          <div class="vm-spinner" id="vm-agent-spinner"></div>
          <span id="vm-agent-headline">Agent is executing changes...</span>
        </div>
        <span class="vm-agent-timer" id="vm-agent-timer">0s</span>
      </div>
      <div class="vm-targets-list" id="vm-agent-targets"></div>
      <div class="vm-steps-feed" id="vm-agent-steps"></div>
    </div>
    <div class="vm-pill" id="vm-main-pill"></div>
  `;
  shadow.appendChild(dock);

  const mainPill = shadow.getElementById('vm-main-pill');
  const agentPanel = shadow.getElementById('vm-agent-panel');
  const agentSpinner = shadow.getElementById('vm-agent-spinner');
  const agentHeadline = shadow.getElementById('vm-agent-headline');
  const agentTimer = shadow.getElementById('vm-agent-timer');
  const agentTargets = shadow.getElementById('vm-agent-targets');
  const agentSteps = shadow.getElementById('vm-agent-steps');

  // --- Check if page just auto-reloaded after an Agent fix ---
  try {
    const justCompletedRaw = sessionStorage.getItem('vm_just_completed');
    if (justCompletedRaw) {
      sessionStorage.removeItem('vm_just_completed');
      const info = JSON.parse(justCompletedRaw);
      if (Date.now() - info.completedAt < 15000) {
        showCompletedBannerAfterReload(info);
      }
    }
  } catch {}

  function showCompletedBannerAfterReload(info) {
    agentPanel.className = 'visible done';
    agentSpinner.className = 'vm-spinner done';
    agentSpinner.innerHTML = ICONS.check;
    agentHeadline.textContent = 'Changes applied and page refreshed';
    agentTimer.textContent = 'Done';
    agentTargets.innerHTML = '';
    agentSteps.innerHTML = `<div class="vm-step-row edit latest"><span class="vm-step-action">${ICONS.check}</span><span>${escapeHtml(info.summary || 'UI updated')}</span></div>`;
    setTimeout(() => {
      if (!agentJob) {
        agentPanel.classList.remove('visible');
      }
    }, 5000);
  }

  // --- Resize Canvas ---
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawCanvas();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // --- Inspect & Resolve Exact Target DOM Element ---
  function resolveTargetElementForStroke(kind, pts) {
    const prevPointerEvents = canvas.style.pointerEvents;
    canvas.style.pointerEvents = 'none';

    let targetEl = null;
    try {
      if (kind === 'arrow' && pts.length > 0) {
        // Arrow binds to the element at the arrowhead tip!
        const tip = pts[pts.length - 1];
        targetEl = pickTopDOMElementAtPoint(tip.x, tip.y);
      } else if (kind === 'select' && pts.length > 0) {
        targetEl = pickTopDOMElementAtPoint(pts[0].x, pts[0].y);
      } else if (pts.length > 0) {
        // For freehand draw or box: sample points along the stroke + centroid to find the exact element inside/under the mark
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const candidates = new Map();
        const sampleCoords = [
          { x: cx, y: cy, weight: 3 },
          { x: (cx + minX) / 2, y: (cy + minY) / 2, weight: 1.5 },
          { x: (cx + maxX) / 2, y: (cy + maxY) / 2, weight: 1.5 }
        ];
        const step = Math.max(1, Math.floor(pts.length / 8));
        for (let i = 0; i < pts.length; i += step) {
          sampleCoords.push({ x: pts[i].x, y: pts[i].y, weight: 1 });
        }

        for (const pt of sampleCoords) {
          const el = pickTopDOMElementAtPoint(pt.x, pt.y);
          if (el) {
            candidates.set(el, (candidates.get(el) || 0) + pt.weight);
          }
        }

        let bestScore = -1;
        for (const [el, score] of candidates.entries()) {
          if (score > bestScore) {
            bestScore = score;
            targetEl = el;
          }
        }
      }
    } finally {
      canvas.style.pointerEvents = prevPointerEvents;
    }

    if (!targetEl) {
      return {
        element: document.body,
        selector: 'body',
        tagName: 'body',
        componentName: null,
        textPreview: '',
        elementBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        computedStyles: {},
        htmlSnippet: ''
      };
    }

    return extractElementMetadata(targetEl);
  }

  function pickTopDOMElementAtPoint(x, y) {
    const clampedX = Math.max(0, Math.min(window.innerWidth - 1, x));
    const clampedY = Math.max(0, Math.min(window.innerHeight - 1, y));
    const elements = document.elementsFromPoint(clampedX, clampedY);
    return (
      elements.find(
        (node) =>
          node !== host &&
          !host.contains(node) &&
          node !== document.documentElement &&
          node !== document.body
      ) || null
    );
  }

  function extractElementMetadata(el) {
    const tagName = el.tagName ? el.tagName.toLowerCase() : 'div';
    const selector = buildCleanSelector(el);
    const componentName = detectFrameworkComponent(el);
    const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const textPreview = rawText.slice(0, 80);
    const rect = el.getBoundingClientRect();

    const cs = window.getComputedStyle(el);
    const computedStyles = {
      display: cs.display,
      position: cs.position,
      flexDirection: cs.display.includes('flex') ? cs.flexDirection : undefined,
      justifyContent: cs.display.includes('flex') || cs.display.includes('grid') ? cs.justifyContent : undefined,
      alignItems: cs.display.includes('flex') || cs.display.includes('grid') ? cs.alignItems : undefined,
      textAlign: cs.textAlign,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      padding: cs.padding,
      margin: cs.margin,
      borderRadius: cs.borderRadius,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`
    };

    let htmlSnippet = el.outerHTML || '';
    if (htmlSnippet.length > 450) {
      const clone = el.cloneNode(false);
      clone.textContent = textPreview ? `${textPreview}...` : '...';
      htmlSnippet = clone.outerHTML;
    }

    return {
      element: el,
      selector,
      tagName,
      componentName,
      textPreview,
      elementBounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      computedStyles,
      htmlSnippet
    };
  }

  function buildCleanSelector(el) {
    if (!el || el.nodeType !== 1) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;

    const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-component');
    if (testId) return `[data-testid="${testId}"]`;

    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && depth < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const classes = Array.from(cur.classList || [])
        .filter((c) => c && !c.startsWith('vm-') && c.length < 32)
        .slice(0, 2);
      if (classes.length > 0) {
        part += '.' + classes.map((c) => CSS.escape(c)).join('.');
      } else if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function detectFrameworkComponent(el) {
    let cur = el;
    let depth = 0;
    while (cur && depth < 6) {
      for (const key of Object.keys(cur)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = cur[key];
          while (fiber) {
            const name = fiber.type && (fiber.type.displayName || fiber.type.name);
            if (name && typeof name === 'string' && /^[A-Z]/.test(name)) {
              return `<${name}>`;
            }
            fiber = fiber.return;
          }
        }
        if (key === '__vueParentComponent' && cur[key]?.type?.name) {
          return `<${cur[key].type.name}>`;
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  // --- 0ms Latency WebAudio Level Meter + Per-Element Scoped Speech Recognition ---
  async function startAudioLevelMeter() {
    if (audioCtx) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyser || !isRecording) return;
        analyser.getByteFrequencyData(data);
        const bars = shadow.querySelectorAll('.vm-eq-bar');
        if (bars.length === 4) {
          const indices = [2, 5, 9, 14];
          bars.forEach((bar, i) => {
            const val = data[indices[i]] || 0;
            const h = Math.max(3, Math.min(14, Math.round((val / 200) * 14)));
            bar.style.height = `${h}px`;
          });
        }
        rafMeterId = requestAnimationFrame(tick);
      };
      rafMeterId = requestAnimationFrame(tick);
    } catch {}
  }

  function stopAudioLevelMeter() {
    if (rafMeterId) cancelAnimationFrame(rafMeterId);
    rafMeterId = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
      analyser = null;
    }
  }

  function startSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      isMicListening = false;
      renderPill();
      return;
    }

    if (recognition) {
      try { recognition.abort(); } catch {}
    }

    recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onstart = () => {
      isMicListening = true;
      renderPill();
    };

    recognition.onresult = (event) => {
      // Route speech strictly to the annotation that was active when these words were spoken!
      const targetAnnotation = flushingAnnotation || selectedAnnotation;
      if (!targetAnnotation) return;

      let utteranceFinal = '';
      let utteranceInterim = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        const t = res[0].transcript.trim();
        if (res.isFinal) {
          utteranceFinal += (utteranceFinal ? ' ' : '') + t;
        } else {
          utteranceInterim += (utteranceInterim ? ' ' : '') + t;
        }
      }

      const combinedUtterance = [utteranceFinal, utteranceInterim].filter(Boolean).join(' ').trim();
      const base = targetAnnotation._committedText || '';
      targetAnnotation.transcript = [base, combinedUtterance].filter(Boolean).join(' ').trim();
      targetAnnotation._latestUtterance = combinedUtterance;

      updatePinInputValue(targetAnnotation);
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        isMicListening = false;
        renderPill();
      }
    };

    recognition.onend = () => {
      // Finalize whatever utterance was in flight
      const targetAnnotation = flushingAnnotation || selectedAnnotation;
      if (targetAnnotation && targetAnnotation._latestUtterance) {
        targetAnnotation._committedText = targetAnnotation.transcript;
        targetAnnotation._latestUtterance = '';
      }
      flushingAnnotation = null;
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }

      if (isRecording && isMicListening) {
        try { recognition.start(); } catch {}
      }
    };

    try {
      recognition.start();
      startAudioLevelMeter();
    } catch {
      isMicListening = false;
    }
  }

  /**
   * Flushes any in-flight speech to the previous annotation and starts a clean
   * utterance boundary for the newly selected element so words never bleed.
   */
  function switchSpeechToNewAnnotation(newAnnotation) {
    if (selectedAnnotation && selectedAnnotation !== newAnnotation) {
      flushingAnnotation = selectedAnnotation;
      selectedAnnotation = newAnnotation;
      if (recognition && isMicListening) {
        try {
          recognition.stop();
        } catch {}
        if (flushTimeout) clearTimeout(flushTimeout);
        flushTimeout = setTimeout(() => {
          flushingAnnotation = null;
        }, 550);
      }
    } else {
      selectedAnnotation = newAnnotation;
    }
  }

  function stopSpeechRecognition() {
    isMicListening = false;
    flushingAnnotation = null;
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    stopAudioLevelMeter();
  }

  // --- Drawing & Element Selection Interaction ---
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  function onPointerMove(e) {
    if (!isRecording) return;

    if (!currentStroke) {
      // Only show hover bounding box when using Select tool; keep Draw/Box/Arrow clean!
      const prevEvents = canvas.style.pointerEvents;
      canvas.style.pointerEvents = 'none';
      const el = pickTopDOMElementAtPoint(e.clientX, e.clientY);
      canvas.style.pointerEvents = prevEvents;

      if (el) {
        hoveredElement = el;
        const meta = extractElementMetadata(el);
        if (activeTool === 'select') {
          const rect = el.getBoundingClientRect();
          hoverBox.style.display = 'block';
          hoverBox.style.left = `${rect.left}px`;
          hoverBox.style.top = `${rect.top}px`;
          hoverBox.style.width = `${rect.width}px`;
          hoverBox.style.height = `${rect.height}px`;
          hoverTag.textContent = `${meta.componentName ? meta.componentName + ' · ' : ''}${meta.selector}`;
        } else {
          hoverBox.style.display = 'none';
        }
      }
      return;
    }

    currentStroke.points.push({ x: e.clientX, y: e.clientY });
    redrawCanvas();
  }

  function onPointerDown(e) {
    if (!isRecording || e.button !== 0) return;
    e.preventDefault();

    hoverBox.style.display = 'none';
    currentStroke = {
      kind: activeTool,
      points: [{ x: e.clientX, y: e.clientY }],
      startedAt: Date.now()
    };
    redrawCanvas();
  }

  function onPointerUp(e) {
    if (!isRecording || !currentStroke) return;
    currentStroke.points.push({ x: e.clientX, y: e.clientY });

    const pts = currentStroke.points;
    const kind = currentStroke.kind;
    const meta = resolveTargetElementForStroke(kind, pts);

    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const strokeBounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(Math.max(...xs) - Math.min(...xs), 12),
      height: Math.max(Math.max(...ys) - Math.min(...ys), 12)
    };

    const annotation = {
      id: `ann-${Date.now()}-${annotations.length + 1}`,
      number: annotations.length + 1,
      kind, // Strict tool preservation: 'draw' stays 'draw', never turns into a box!
      points: pts,
      bounds: kind === 'select' ? meta.elementBounds : strokeBounds,
      elementBounds: meta.elementBounds,
      selector: meta.selector,
      tagName: meta.tagName,
      componentName: meta.componentName,
      textPreview: meta.textPreview,
      computedStyles: meta.computedStyles,
      htmlSnippet: meta.htmlSnippet,
      _committedText: '',
      _latestUtterance: '',
      transcript: '',
      createdAt: new Date().toISOString()
    };

    annotations.push(annotation);
    switchSpeechToNewAnnotation(annotation);

    currentStroke = null;
    redrawCanvas();
    renderOverlays();
    renderPill();
  }

  // --- Smooth Canvas Rendering (Pencil never draws a rectangle box) ---
  function redrawCanvas() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const item of annotations) {
      drawAnnotationGraphic(item.kind, item.points, item.number);
    }
    if (currentStroke) {
      drawAnnotationGraphic(currentStroke.kind, currentStroke.points, annotations.length + 1);
    }
  }

  function drawAnnotationGraphic(kind, pts, number) {
    if (!pts || pts.length === 0) return;

    // 'select' uses the crisp DOM element lock frame in #vm-overlays, not canvas strokes
    if (kind === 'select') return;

    ctx.save();
    ctx.strokeStyle = '#f43f5e';
    ctx.fillStyle = 'rgba(244, 63, 94, 0.08)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (kind === 'box') {
      const start = pts[0];
      const end = pts[pts.length - 1];
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      ctx.strokeRect(x, y, w, h);
      ctx.fillRect(x, y, w, h);
    } else if (kind === 'arrow') {
      const start = pts[0];
      const end = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();

      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const headLen = 13;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = '#f43f5e';
      ctx.fill();
    } else if (kind === 'draw') {
      // Smooth quadratic curve freehand ink — never draws a rectangle box
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, 2, 0, Math.PI * 2);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const midX = (pts[i].x + pts[i + 1].x) / 2;
          const midY = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
    }

    // Numbered callout marker on annotation canvas
    const anchor = pts[0];
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#f43f5e';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), anchor.x, anchor.y);

    ctx.restore();
  }

  // --- Render Bound Element Lock Frames & Scoped Input Cards ---
  function renderOverlays() {
    overlaysContainer.innerHTML = '';

    annotations.forEach((item, idx) => {
      item.number = idx + 1;
      const isFocused = selectedAnnotation === item;

      // 1. Subtle element lock outline showing the exact DOM element bound to this annotation
      if (item.elementBounds) {
        const lock = document.createElement('div');
        lock.className = `vm-element-lock ${isFocused ? 'focused' : ''}`;
        lock.style.left = `${item.elementBounds.x}px`;
        lock.style.top = `${item.elementBounds.y}px`;
        lock.style.width = `${item.elementBounds.width}px`;
        lock.style.height = `${item.elementBounds.height}px`;
        overlaysContainer.appendChild(lock);
      }

      // 2. Scoped Annotation Card anchored to the element
      const card = document.createElement('div');
      card.className = `vm-pin-card ${isFocused ? 'focused' : ''}`;
      card.dataset.annId = item.id;

      const anchorBox = item.elementBounds || item.bounds;
      const cardLeft = Math.max(12, Math.min(window.innerWidth - 282, anchorBox.x));
      const cardTop =
        anchorBox.y + anchorBox.height + 8 + 76 < window.innerHeight - 70
          ? anchorBox.y + anchorBox.height + 8
          : Math.max(12, anchorBox.y - 74);

      card.style.left = `${cardLeft}px`;
      card.style.top = `${cardTop}px`;

      card.innerHTML = `
        <div class="vm-pin-header">
          <div class="vm-pin-meta">
            <span class="vm-pin-num">${item.number}</span>
            <span class="vm-pin-selector" title="${escapeHtml(item.selector)}">${escapeHtml(item.componentName ? item.componentName + ' ' + item.selector : item.selector)}</span>
          </div>
          <button class="vm-pin-del" title="Remove annotation">${ICONS.close}</button>
        </div>
        <input
          class="vm-pin-input"
          type="text"
          value="${escapeHtml(item.transcript)}"
          placeholder="${isFocused && isMicListening ? 'Speak now or type instruction...' : 'Type instruction for this element...'}"
        />
      `;

      card.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (selectedAnnotation !== item) {
          switchSpeechToNewAnnotation(item);
          renderOverlays();
        }
      });

      const input = card.querySelector('.vm-pin-input');
      input.addEventListener('input', () => {
        item.transcript = input.value;
        item._committedText = input.value;
        item._latestUtterance = '';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitFeedbackToAgent();
        }
      });

      card.querySelector('.vm-pin-del').addEventListener('click', (e) => {
        e.stopPropagation();
        annotations.splice(idx, 1);
        if (selectedAnnotation === item) {
          selectedAnnotation = annotations[annotations.length - 1] || null;
        }
        redrawCanvas();
        renderOverlays();
        renderPill();
      });

      overlaysContainer.appendChild(card);

      if (isFocused) {
        setTimeout(() => {
          input.focus();
          const len = input.value.length;
          input.setSelectionRange(len, len);
        }, 20);
      }
    });
  }

  function updatePinInputValue(annotation) {
    const card = overlaysContainer.querySelector(`[data-ann-id="${annotation.id}"]`);
    if (!card) return;
    const input = card.querySelector('.vm-pin-input');
    if (input) {
      input.value = annotation.transcript;
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Mode Toggling ---
  function startRecording() {
    isRecording = true;
    canvas.classList.add('active');
    startSpeechRecognition();
    renderPill();
  }

  function stopRecording(clearAll = false) {
    isRecording = false;
    canvas.classList.remove('active');
    hoverBox.style.display = 'none';
    stopSpeechRecognition();
    if (clearAll) {
      annotations = [];
      selectedAnnotation = null;
      redrawCanvas();
      renderOverlays();
    }
    renderPill();
  }

  function toggleRecording() {
    if (isRecording) {
      stopRecording(true);
    } else {
      startRecording();
    }
  }
  window.__QUICK_FEEDBACK_TOGGLE__ = toggleRecording;

  // --- Live Agent Execution Panel ---
  function startAgentJobUI(jobInfo) {
    agentJob = {
      sessionId: jobInfo.sessionId,
      startedAt: jobInfo.startedAt || Date.now(),
      annotations: jobInfo.annotations || [],
      steps: jobInfo.steps || [],
      status: 'running'
    };
    agentPanel.className = 'visible';
    agentSpinner.className = 'vm-spinner';
    agentSpinner.innerHTML = '';
    agentHeadline.textContent = `Agent working on ${agentJob.annotations.length || 1} element(s)...`;

    renderAgentJobDetails();

    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!agentJob || agentJob.status !== 'running') return;
      const secs = Math.max(0, Math.floor((Date.now() - agentJob.startedAt) / 1000));
      agentTimer.textContent = `${secs}s`;
    }, 500);
  }

  function renderAgentJobDetails() {
    if (!agentJob) return;

    agentTargets.innerHTML = agentJob.annotations
      .map(
        (a) => `
        <div class="vm-target-chip">
          <strong>#${a.number}</strong>
          <code>${escapeHtml(a.selector)}</code>
          ${a.transcript ? `<span>"${escapeHtml(a.transcript)}"</span>` : ''}
        </div>
      `
      )
      .join('');

    const steps = agentJob.steps || [];
    agentSteps.innerHTML = steps
      .map((s, idx) => {
        const isLatest = idx === steps.length - 1;
        const isEdit = s.kind === 'edit';
        const svgIcon = isEdit ? ICONS.code : ICONS.step;
        return `
          <div class="vm-step-row ${isLatest ? 'latest' : ''} ${isEdit ? 'edit' : ''}">
            <span class="vm-step-action">${svgIcon} ${escapeHtml(s.action || 'Step')}:</span>
            <span>${escapeHtml(s.detail || '')}</span>
          </div>
        `;
      })
      .join('');
    agentSteps.scrollTop = agentSteps.scrollHeight;
  }

  // --- Submit Feedback to Connected Agent ---
  async function submitFeedbackToAgent() {
    if (annotations.length === 0) return;

    const submittedAnnotations = annotations.map((a, idx) => ({
      number: idx + 1,
      kind: a.kind,
      points: a.points,
      bounds: a.elementBounds || a.bounds,
      selector: a.selector,
      tagName: a.tagName,
      componentName: a.componentName,
      textPreview: a.textPreview,
      computedStyles: a.computedStyles,
      htmlSnippet: a.htmlSnippet,
      transcript: (a.transcript || '').trim(),
      createdAt: a.createdAt
    }));

    const fullTranscript = submittedAnnotations
      .map((a) => `[#${a.number} ${a.selector}]: ${a.transcript}`)
      .join(' | ');

    stopSpeechRecognition();
    hoverBox.style.display = 'none';
    canvas.classList.remove('active');
    isRecording = false;
    renderPill();

    startAgentJobUI({
      sessionId: 'pending',
      startedAt: Date.now(),
      annotations: submittedAnnotations,
      steps: [{ kind: 'init', action: 'Binding DOM', detail: 'Binding DOM selectors, computed styles & WebMCP context' }]
    });

    annotations = [];
    selectedAnnotation = null;
    redrawCanvas();
    renderOverlays();
    renderPill();

    const payload = {
      url: window.location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fullTranscript,
      annotations: submittedAnnotations,
      webmcpTools: getSerializableWebMcpTools(),
      createdAt: new Date().toISOString()
    };

    try {
      const response = await fetch(`${BRIDGE_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Bridge returned HTTP ${response.status}`);
      }

      const result = await response.json();
      if (agentJob) {
        agentJob.sessionId = result.id;
        agentJob.steps.push({
          kind: 'init',
          action: 'Dispatched',
          detail: `Session ${result.id} sent to agent`
        });
        renderAgentJobDetails();
      }
    } catch {
      agentPanel.className = 'visible error';
      agentSpinner.className = 'vm-spinner done';
      agentSpinner.innerHTML = ICONS.alert;
      agentHeadline.textContent = `Bridge offline (${BRIDGE_URL}) — Prompt copied to clipboard`;
    }
  }

  // --- Pill UI Rendering (Professional Vector Icons, Zero Emojis) ---
  function renderPill() {
    if (!isRecording) {
      mainPill.innerHTML = `
        <span class="vm-status-dot ${bridgeOnline ? 'online' : ''}" title="${bridgeOnline ? 'Voxmark Bridge Online' : 'Bridge Offline (' + BRIDGE_URL + ')'}"></span>
        <button class="vm-btn" id="vm-start-btn" title="Start Voxmark annotation (Alt+F)">
          ${ICONS.mic}
          <span>Voxmark</span>
          <span class="vm-kbd">Alt+F</span>
        </button>
      `;
      mainPill.querySelector('#vm-start-btn').addEventListener('click', startRecording);
      return;
    }

    mainPill.innerHTML = `
      <button class="vm-btn ${isMicListening ? 'active' : ''}" id="vm-mic-toggle" title="${isMicListening ? 'Microphone active — click to mute' : 'Microphone muted — click to unmute'}">
        ${isMicListening ? ICONS.mic : ICONS.micOff}
        <span class="vm-eq">
          <span class="vm-eq-bar"></span>
          <span class="vm-eq-bar"></span>
          <span class="vm-eq-bar"></span>
          <span class="vm-eq-bar"></span>
        </span>
      </button>
      <div class="vm-divider"></div>
      <button class="vm-btn ${activeTool === 'select' ? 'active' : ''}" data-tool="select" title="Select Element">${ICONS.select}<span>Select</span></button>
      <button class="vm-btn ${activeTool === 'draw' ? 'active' : ''}" data-tool="draw" title="Freehand Ink">${ICONS.draw}<span>Draw</span></button>
      <button class="vm-btn ${activeTool === 'box' ? 'active' : ''}" data-tool="box" title="Region Box">${ICONS.box}<span>Box</span></button>
      <button class="vm-btn ${activeTool === 'arrow' ? 'active' : ''}" data-tool="arrow" title="Point Arrow">${ICONS.arrow}<span>Arrow</span></button>
      <div class="vm-divider"></div>
      <button class="vm-btn" id="vm-clear-btn" title="Clear all annotations">Clear (${annotations.length})</button>
      <button class="vm-btn primary" id="vm-send-btn" title="Execute changes with connected agent (Enter)">
        ${ICONS.send}
        <span>Apply</span>
        <span class="vm-kbd" style="background:rgba(0,0,0,0.12);color:#09090b;">Enter</span>
      </button>
      <button class="vm-btn" id="vm-cancel-btn" title="Exit (Esc)">${ICONS.close}</button>
    `;

    mainPill.querySelector('#vm-mic-toggle').addEventListener('click', () => {
      if (isMicListening) {
        stopSpeechRecognition();
        renderPill();
      } else {
        startSpeechRecognition();
      }
    });

    mainPill.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTool = btn.getAttribute('data-tool');
        hoverBox.style.display = 'none';
        renderPill();
      });
    });

    mainPill.querySelector('#vm-clear-btn').addEventListener('click', () => {
      annotations = [];
      selectedAnnotation = null;
      redrawCanvas();
      renderOverlays();
      renderPill();
    });

    mainPill.querySelector('#vm-send-btn').addEventListener('click', submitFeedbackToAgent);
    mainPill.querySelector('#vm-cancel-btn').addEventListener('click', () => stopRecording(true));
  }

  // --- Keyboard Shortcuts ---
  window.addEventListener('keydown', (e) => {
    if ((e.altKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleRecording();
      return;
    }
    if (e.altKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
      e.preventDefault();
      toggleRecording();
      return;
    }
    if (isRecording && e.key === 'Escape') {
      e.preventDefault();
      stopRecording(true);
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'QF_TOGGLE') {
        toggleRecording();
        sendResponse({ ok: true, isRecording });
      }
      return false;
    });
  }

  // --- WebMCP (navigator.modelContext) Runtime & Two-Way Agent Tool Registry ---
  const webMcpTools = new Map();

  function getSerializableWebMcpTools() {
    return Array.from(webMcpTools.values()).map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || t.inputSchema || { type: 'object', properties: {} },
      source: t.source || 'app'
    }));
  }

  function syncWebMcpToolsToBridge() {
    if (!bridgeOnline) return;
    fetch(`${BRIDGE_URL}/api/webmcp/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: window.location.href,
        title: document.title,
        tools: getSerializableWebMcpTools()
      })
    }).catch(() => {});
  }

  function setupWebMcpRuntime() {
    const existingMc = typeof navigator !== 'undefined' ? navigator.modelContext : null;
    const nativeRegister =
      existingMc && typeof existingMc.registerTool === 'function'
        ? existingMc.registerTool.bind(existingMc)
        : null;

    const mc = existingMc || {};

    mc.registerTool = function (toolDef, ...rest) {
      if (toolDef && toolDef.name) {
        webMcpTools.set(toolDef.name, {
          name: toolDef.name,
          description: toolDef.description || '',
          parameters: toolDef.parameters || toolDef.inputSchema || { type: 'object', properties: {} },
          handler: toolDef.handler || toolDef.execute,
          source: toolDef._voxmarkBuiltin ? 'voxmark' : 'app'
        });
        syncWebMcpToolsToBridge();
      }
      if (nativeRegister) {
        try {
          return nativeRegister(toolDef, ...rest);
        } catch {}
      }
    };

    mc.unregisterTool = function (name) {
      webMcpTools.delete(name);
      syncWebMcpToolsToBridge();
    };

    mc.listTools = function () {
      return getSerializableWebMcpTools();
    };

    mc.callTool = async function (name, args = {}) {
      const tool = webMcpTools.get(name);
      if (!tool || typeof tool.handler !== 'function') {
        throw new Error(`WebMCP tool not found: ${name}`);
      }
      return await tool.handler(args || {});
    };

    if (typeof mc.provideContext !== 'function') {
      mc.provideContext = function (ctx) {
        if (ctx && Array.isArray(ctx.tools)) {
          ctx.tools.forEach((t) => mc.registerTool(t));
        }
      };
    }

    if (typeof navigator !== 'undefined' && !('modelContext' in navigator)) {
      try {
        Object.defineProperty(navigator, 'modelContext', {
          value: mc,
          configurable: true,
          writable: true
        });
      } catch {
        window.modelContext = mc;
      }
    }

    // Register Voxmark's 4 Built-in Live DOM & Annotation WebMCP Tools
    mc.registerTool({
      _voxmarkBuiltin: true,
      name: 'voxmark_get_annotations',
      description:
        'Return all active voice + visual DOM annotations currently pinned on the page in Voxmark.',
      parameters: {
        type: 'object',
        properties: {}
      },
      handler: async () => ({
        url: window.location.href,
        title: document.title,
        isRecording,
        annotations: annotations.map((a, idx) => ({
          number: idx + 1,
          kind: a.kind,
          selector: a.selector,
          tagName: a.tagName,
          componentName: a.componentName,
          transcript: a.transcript,
          bounds: a.elementBounds || a.bounds,
          computedStyles: a.computedStyles
        }))
      })
    });

    mc.registerTool({
      _voxmarkBuiltin: true,
      name: 'voxmark_inspect_dom',
      description:
        'Inspect any live DOM element by CSS selector, returning its bounding box, computed CSS styles, parent layout styles, and HTML snippet.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector to query in the live document (e.g. "#hero-header", ".metric-card")'
          }
        },
        required: ['selector']
      },
      handler: async ({ selector }) => {
        const matches = Array.from(document.querySelectorAll(selector));
        if (matches.length === 0) {
          return { found: false, count: 0, selector };
        }
        const el = matches[0];
        const meta = extractElementMetadata(el);
        const parentCs = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
        return {
          found: true,
          count: matches.length,
          selector: meta.selector,
          queriedSelector: selector,
          tagName: meta.tagName,
          componentName: meta.componentName,
          textPreview: meta.textPreview,
          bounds: meta.elementBounds,
          computedStyles: meta.computedStyles,
          parentComputedStyles: parentCs
            ? {
                display: parentCs.display,
                flexDirection: parentCs.flexDirection,
                justifyContent: parentCs.justifyContent,
                alignItems: parentCs.alignItems,
                gridTemplateColumns: parentCs.gridTemplateColumns,
                width: `${Math.round(el.parentElement.getBoundingClientRect().width)}px`
              }
            : null,
          htmlSnippet: meta.htmlSnippet
        };
      }
    });

    mc.registerTool({
      _voxmarkBuiltin: true,
      name: 'voxmark_preview_styles',
      description:
        'Apply instant 0ms live CSS style overrides or text content to a DOM element in the browser to preview and verify layout before or while editing source files.',
      parameters: {
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
      },
      handler: async ({ selector, styles = {}, textContent }) => {
        const matches = Array.from(document.querySelectorAll(selector));
        if (matches.length === 0) {
          return { ok: false, error: `No element matched selector: ${selector}` };
        }
        matches.forEach((el) => {
          if (styles && typeof styles === 'object') {
            for (const [k, v] of Object.entries(styles)) {
              if (k.includes('-')) {
                el.style.setProperty(k, String(v));
              } else {
                el.style[k] = String(v);
              }
            }
          }
          if (typeof textContent === 'string') {
            el.textContent = textContent;
          }
        });
        const updatedMeta = extractElementMetadata(matches[0]);
        return {
          ok: true,
          matchedCount: matches.length,
          selector: updatedMeta.selector,
          bounds: updatedMeta.elementBounds,
          computedStyles: updatedMeta.computedStyles
        };
      }
    });

    mc.registerTool({
      _voxmarkBuiltin: true,
      name: 'voxmark_highlight_element',
      description:
        'Highlight a DOM element on the user screen with an agent callout label to visually indicate what the agent is inspecting or editing.',
      parameters: {
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
      },
      handler: async ({ selector, label = 'Agent inspecting', durationMs = 2500 }) => {
        const el = document.querySelector(selector);
        if (!el) return { ok: false, error: `No element matched selector: ${selector}` };
        const rect = el.getBoundingClientRect();
        hoverBox.style.display = 'block';
        hoverBox.style.left = `${rect.left}px`;
        hoverBox.style.top = `${rect.top}px`;
        hoverBox.style.width = `${rect.width}px`;
        hoverBox.style.height = `${rect.height}px`;
        hoverTag.textContent = `${selector} — ${label}`;
        setTimeout(() => {
          if (!isRecording) hoverBox.style.display = 'none';
        }, durationMs);
        return {
          ok: true,
          selector,
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        };
      }
    });
  }

  // --- Connect to Local Agent Bridge SSE Stream ---
  function connectBridgeEvents() {
    fetch(`${BRIDGE_URL}/api/health`)
      .then((r) => r.json())
      .then((health) => {
        bridgeOnline = true;
        renderPill();
        syncWebMcpToolsToBridge();
        if (health.activeJob && !agentJob) {
          startAgentJobUI(health.activeJob);
        }
      })
      .catch(() => {
        bridgeOnline = false;
        renderPill();
      });

    try {
      const es = new EventSource(`${BRIDGE_URL}/api/events`);
      es.onopen = () => {
        bridgeOnline = true;
        renderPill();
        syncWebMcpToolsToBridge();
      };
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.type === 'connected' && data.activeJob && !agentJob) {
            startAgentJobUI(data.activeJob);
          } else if (data.type === 'webmcp_call') {
            // Execute live WebMCP tool inside the browser tab and return result to Bridge
            const { callId, name, arguments: toolArgs } = data;
            navigator.modelContext
              .callTool(name, toolArgs || {})
              .then((result) => {
                fetch(`${BRIDGE_URL}/api/webmcp/result`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ callId, ok: true, result })
                }).catch(() => {});
              })
              .catch((err) => {
                fetch(`${BRIDGE_URL}/api/webmcp/result`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ callId, ok: false, error: err.message })
                }).catch(() => {});
              });
          } else if (data.type === 'started') {
            if (!agentJob) {
              startAgentJobUI({ sessionId: data.sessionId, startedAt: Date.now(), annotations: [], steps: [] });
            }
            agentJob.steps.push({
              kind: 'init',
              action: 'Started',
              detail: data.message || `Working in ${data.targetDir}`
            });
            renderAgentJobDetails();
          } else if (data.type === 'step') {
            if (!agentJob) {
              startAgentJobUI({ sessionId: data.sessionId, startedAt: Date.now(), annotations: [], steps: [] });
            }
            agentHeadline.textContent = `Agent: ${data.action || 'Working'}...`;
            agentJob.steps.push(data);
            renderAgentJobDetails();
          } else if (data.type === 'completed') {
            if (elapsedTimer) clearInterval(elapsedTimer);
            if (agentJob) agentJob.status = 'done';
            agentPanel.className = 'visible done';
            agentSpinner.className = 'vm-spinner done';
            agentSpinner.innerHTML = ICONS.check;
            agentHeadline.textContent = 'Changes applied — refreshing page...';
            if (agentJob) {
              agentJob.steps.push({
                kind: 'edit',
                action: 'Completed',
                detail: data.summary || 'All changes applied'
              });
              renderAgentJobDetails();
            }
            try {
              sessionStorage.setItem(
                'vm_just_completed',
                JSON.stringify({
                  summary: data.summary || 'UI changes applied.',
                  completedAt: Date.now()
                })
              );
            } catch {}
            setTimeout(() => {
              window.location.reload();
            }, 650);
          } else if (data.type === 'failed' || data.type === 'error') {
            if (elapsedTimer) clearInterval(elapsedTimer);
            if (agentJob) agentJob.status = 'error';
            agentPanel.className = 'visible error';
            agentSpinner.className = 'vm-spinner done';
            agentSpinner.innerHTML = ICONS.alert;
            agentHeadline.textContent = `Agent error: ${data.error || data.summary || 'check terminal'}`;
          }
        } catch {}
      };
      es.onerror = () => {
        bridgeOnline = false;
        renderPill();
      };
    } catch {}
  }

  setupWebMcpRuntime();
  renderPill();
  connectBridgeEvents();
})();
