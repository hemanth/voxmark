import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.tsx',
  '.jsx',
  '.ts',
  '.js',
  '.mjs',
  '.vue',
  '.svelte',
  '.astro'
]);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.quick-feedback',
  'dist',
  'build',
  '.next',
  'renders',
  'videos',
  'extension',
  'test',
  'tests',
  'coverage'
]);

function collectCandidateFiles(targetDir, url = '') {
  const candidates = [];
  const isDemoUrl = url.includes('/demo');
  const demoFile = path.join(targetDir, 'demo', 'index.html');
  const rootIndex = path.join(targetDir, 'index.html');

  if (isDemoUrl && fs.existsSync(demoFile)) {
    return [demoFile];
  }
  if (fs.existsSync(rootIndex)) {
    candidates.push(rootIndex);
  }

  function walk(dir, depth = 0) {
    if (depth > 6 || candidates.length >= 200) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      if (!isDemoUrl && depth === 0 && entry.name === 'demo') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        if (!candidates.includes(fullPath)) {
          candidates.push(fullPath);
        }
      }
    }
  }

  walk(targetDir, 0);

  if (candidates.length === 0 && fs.existsSync(demoFile)) {
    candidates.push(demoFile);
  }

  return candidates;
}

function extractSearchTokens(annotation) {
  const tokens = [];
  const sel = (annotation.selector || '').trim();
  if (sel) {
    tokens.push(sel);
    const idMatches = sel.match(/#[a-zA-Z0-9_-]+/g) || [];
    for (const idToken of idMatches) {
      const rawId = idToken.slice(1);
      tokens.push(idToken);
      tokens.push(`id="${rawId}"`);
      tokens.push(`id='${rawId}'`);
      tokens.push(`'${rawId}'`);
      tokens.push(`"${rawId}"`);
    }
    const classMatches = sel.match(/\.[a-zA-Z0-9_-]+/g) || [];
    for (const cls of classMatches) {
      tokens.push(cls);
      tokens.push(cls.slice(1));
    }
    const attrMatches = sel.match(/\[([a-zA-Z0-9_-]+)=["']?([^"'\]]+)["']?\]/g) || [];
    for (const attr of attrMatches) {
      tokens.push(attr.replace(/^\[|\]$/g, ''));
    }
  }

  const compNames = [];
  if (annotation.componentName) compNames.push(annotation.componentName);
  if (Array.isArray(annotation.componentChain)) {
    compNames.push(...annotation.componentChain);
  }
  for (const rawComp of compNames) {
    const cleanComp = String(rawComp).replace(/[<>]/g, '').trim();
    if (cleanComp && cleanComp.length >= 2 && cleanComp !== 'App') {
      tokens.push(cleanComp);
      tokens.push(`<${cleanComp}`);
      tokens.push(`function ${cleanComp}`);
      tokens.push(`const ${cleanComp}`);
    }
  }

  if (Array.isArray(annotation.nestedChildren)) {
    for (const child of annotation.nestedChildren.slice(0, 4)) {
      if (child.selector && child.selector.startsWith('#')) {
        const childId = child.selector.slice(1);
        tokens.push(child.selector);
        tokens.push(childId);
      }
      if (child.componentName) {
        const cleanChildComp = String(child.componentName).replace(/[<>]/g, '').trim();
        if (cleanChildComp) tokens.push(cleanChildComp);
      }
    }
  }

  if (annotation.textPreview && annotation.textPreview.trim().length >= 3) {
    tokens.push(annotation.textPreview.trim().slice(0, 40));
  }
  return [...new Set(tokens.filter(Boolean))];
}

function resolveFileFromSourceLocation(sourceLocation, targetDir) {
  if (!sourceLocation || !sourceLocation.fileName) return null;
  const rawFile = String(sourceLocation.fileName).replace(/^file:\/\//, '');
  if (path.isAbsolute(rawFile) && fs.existsSync(rawFile)) {
    return rawFile;
  }
  const candidate = path.resolve(targetDir, rawFile.replace(/^\/+/, ''));
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function resolveSourceSnippets(annotations, targetDir, url) {
  const files = collectCandidateFiles(targetDir, url);
  const snippets = [];
  const seenFileRanges = new Set();

  function addSnippet(file, startLine, endLine, fileLines) {
    const key = `${file}:${startLine}-${endLine}`;
    if (seenFileRanges.has(key)) return;
    seenFileRanges.add(key);
    const slice = fileLines
      .slice(startLine - 1, endLine)
      .map((line, idx) => `${startLine + idx}: ${line}`)
      .join('\n');
    snippets.push({
      file,
      startLine,
      endLine,
      numberedText: slice
    });
  }

  // 1. Prioritize exact framework source locations (_debugSource, __file, __svelte_meta, data-astro-source-file)
  for (const ann of annotations) {
    const exactFile = resolveFileFromSourceLocation(ann.sourceLocation, targetDir);
    if (exactFile) {
      try {
        const content = fs.readFileSync(exactFile, 'utf8');
        const fileLines = content.split('\n');
        const line = Number(ann.sourceLocation.lineNumber) || 1;
        const start = Math.max(1, line - 8);
        const end = Math.min(fileLines.length, line + 30);
        addSnippet(exactFile, start, end, fileLines);
      } catch {}
    }
  }

  // 2. Prioritize files whose filename matches any component in componentChain
  const componentBaseNames = new Set();
  for (const ann of annotations) {
    const chain = Array.isArray(ann.componentChain)
      ? ann.componentChain
      : ann.componentName
        ? [ann.componentName]
        : [];
    for (const c of chain) {
      const clean = String(c).replace(/[<>]/g, '').trim().toLowerCase();
      if (clean && clean !== 'app') componentBaseNames.add(clean);
    }
  }

  const sortedFiles = [...files].sort((a, b) => {
    const baseA = path.basename(a, path.extname(a)).toLowerCase();
    const baseB = path.basename(b, path.extname(b)).toLowerCase();
    const aMatch = componentBaseNames.has(baseA) ? 0 : 1;
    const bMatch = componentBaseNames.has(baseB) ? 0 : 1;
    return aMatch - bMatch;
  });

  // 3. Token search across project files
  for (const file of sortedFiles) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fileLines = content.split('\n');
    const matchedRanges = [];

    const baseName = path.basename(file, path.extname(file)).toLowerCase();
    if (componentBaseNames.has(baseName)) {
      matchedRanges.push({ start: 1, end: Math.min(fileLines.length, 45) });
    }

    for (const ann of annotations) {
      const tokens = extractSearchTokens(ann);
      for (const token of tokens) {
        for (let i = 0; i < fileLines.length; i++) {
          if (fileLines[i].includes(token)) {
            const start = Math.max(1, i + 1 - 4);
            const end = Math.min(fileLines.length, i + 1 + 24);
            matchedRanges.push({ start, end });
          }
        }
        if (matchedRanges.length >= 5) break;
      }
    }

    if (matchedRanges.length === 0) continue;

    matchedRanges.sort((a, b) => a.start - b.start);
    const merged = [matchedRanges[0]];
    for (let i = 1; i < matchedRanges.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = matchedRanges[i];
      if (curr.start <= prev.end + 4) {
        prev.end = Math.max(prev.end, curr.end);
      } else {
        merged.push(curr);
      }
    }

    for (const range of merged.slice(0, 4)) {
      addSnippet(file, range.start, range.end, fileLines);
    }
  }

  return snippets.slice(0, 8);
}

/**
 * Builds a structured, low-latency prompt for the coding agent from a
 * live voice + DOM annotation + WebMCP session.
 */
export function buildAgentPrompt(session, options = {}) {
  const {
    id,
    url = 'unknown',
    title = '',
    viewport = {},
    fullTranscript = '',
    annotations = [],
    webmcpTools = [],
    createdAt = new Date().toISOString()
  } = session;

  const targetDir = options.targetDir || process.cwd();
  const bridgeUrl = options.bridgeUrl || 'http://127.0.0.1:4747';
  const lines = [];

  lines.push(`# Live UI Feedback Request (${id})`);
  lines.push('');
  lines.push(`The user recorded live voice and DOM annotations on the running web app in \`${targetDir}\`.`);
  lines.push(
    `CRITICAL INSTRUCTION: Fulfill the user's spoken request completely — whether it involves UI styling, nested component changes, state/props wiring, event handlers, or multi-file logic. If the target code is already shown in the Pre-Resolved Source Lines below, edit it immediately using \`replace_file_content\` without redundant file reads; if the change spans additional nested components or modules, inspect and update all necessary files in \`${targetDir}\`.`
  );
  lines.push('');
  lines.push(`## Page Context`);
  lines.push(`- **URL**: ${url}`);
  lines.push(`- **Project Root**: \`${targetDir}\``);

  const demoCandidate = path.join(targetDir, 'demo', 'index.html');
  const rootIndexCandidate = path.join(targetDir, 'index.html');
  if (url.includes('/demo') && fs.existsSync(demoCandidate)) {
    lines.push(`- **Target Source File**: \`${demoCandidate}\` (edit this file directly)`);
  } else if (fs.existsSync(rootIndexCandidate)) {
    lines.push(`- **Likely Entry File**: \`${rootIndexCandidate}\``);
  }

  if (title) lines.push(`- **Title**: ${title}`);
  if (viewport.width && viewport.height) {
    lines.push(`- **Viewport**: ${viewport.width}x${viewport.height}`);
  }
  lines.push(`- **Timestamp**: ${createdAt}`);
  lines.push('');

  if (fullTranscript.trim()) {
    lines.push(`## Full Voice Transcript`);
    lines.push(`> "${fullTranscript.trim()}"`);
    lines.push('');
  }

  if (annotations.length > 0) {
    lines.push(`## Highlighted Elements & Spoken Instructions`);
    lines.push('');

    annotations.forEach((item, idx) => {
      const num = item.number || idx + 1;
      const instruction =
        (item.transcript || item.note || '').trim() ||
        '(Refer to full voice transcript above for this highlighted area)';
      lines.push(
        `### #${num} — ${item.kind ? `[${item.kind.toUpperCase()}] ` : ''}\`${item.selector || item.tagName || 'region'}\``
      );
      lines.push(`- **Spoken / Annotated Instruction**: "${instruction}"`);

      if (Array.isArray(item.componentChain) && item.componentChain.length > 0) {
        lines.push(`- **Component Hierarchy**: \`${item.componentChain.join(' > ')}\``);
      } else if (item.componentName) {
        lines.push(`- **Component**: \`${item.componentName}\``);
      }
      if (item.sourceLocation && item.sourceLocation.fileName) {
        const locStr = item.sourceLocation.lineNumber
          ? `${item.sourceLocation.fileName}:${item.sourceLocation.lineNumber}`
          : item.sourceLocation.fileName;
        lines.push(`- **Component Source Location**: \`${locStr}\``);
      }
      if (item.componentProps && Object.keys(item.componentProps).length > 0) {
        lines.push(`- **Live Component Props / Handlers**: \`${JSON.stringify(item.componentProps)}\``);
      }
      if (item.domHierarchy) {
        lines.push(`- **DOM Ancestry**: \`${item.domHierarchy}\``);
      }
      if (item.tagName) {
        lines.push(
          `- **Element Tag**: \`<${item.tagName.toLowerCase()}>\`${item.textPreview ? ` — Text: "${item.textPreview}"` : ''}`
        );
      }
      if (Array.isArray(item.nestedChildren) && item.nestedChildren.length > 0) {
        const childrenDesc = item.nestedChildren
          .map(
            (c) =>
              `\`${c.componentName ? c.componentName + ' ' : ''}${c.selector}\`${c.text ? ` ("${c.text}")` : ''}`
          )
          .join(', ');
        lines.push(`- **Nested Interactive Children**: ${childrenDesc}`);
      }
      if (item.bounds) {
        lines.push(
          `- **Screen Region**: \`x=${Math.round(item.bounds.x)}, y=${Math.round(item.bounds.y)}, w=${Math.round(item.bounds.width)}, h=${Math.round(item.bounds.height)}\``
        );
      }
      if (item.computedStyles && Object.keys(item.computedStyles).length > 0) {
        const stylePairs = Object.entries(item.computedStyles)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        if (stylePairs) {
          lines.push(`- **Current Computed Styles**: \`${stylePairs}\``);
        }
      }
      if (item.htmlSnippet) {
        lines.push(`- **DOM Snippet**:`);
        lines.push('```html');
        lines.push(item.htmlSnippet.trim());
        lines.push('```');
      }
      lines.push('');
    });
  }

  const preResolved = resolveSourceSnippets(annotations, targetDir, url);
  if (preResolved.length > 0) {
    lines.push(`## Pre-Resolved Source Lines (1-Indexed — Edit Directly with \`replace_file_content\`)`);
    lines.push(
      `Each line below is prefixed with \`<line_number>: \`. Strip the \`<line_number>: \` prefix when passing \`TargetContent\` to \`replace_file_content\`:`
    );
    lines.push('');
    for (const snip of preResolved) {
      lines.push(`### \`${snip.file}\` (Lines ${snip.startLine}–${snip.endLine})`);
      lines.push('```');
      lines.push(snip.numberedText);
      lines.push('```');
      lines.push('');
    }
  }

  if (Array.isArray(webmcpTools) && webmcpTools.length > 0) {
    lines.push(`## Live In-Browser WebMCP Tools (\`navigator.modelContext\`)`);
    lines.push(
      `The running browser tab exposes ${webmcpTools.length} live WebMCP tool(s) via \`POST ${bridgeUrl}/api/webmcp/call\` with JSON body \`{"name":"<tool>","arguments":{...}}\`:`
    );
    webmcpTools.forEach((t) => {
      lines.push(`- **\`${t.name}\`** (${t.source || 'app'}): ${t.description || 'In-page WebMCP tool'}`);
    });
    lines.push('');
  }

  lines.push(`## Action Required`);
  lines.push(
    `1. Apply the requested UI, nested component, state, or behavior changes in \`${targetDir}\` (using \`replace_file_content\` directly on pre-resolved lines where applicable, and updating any nested/related component files as needed).`
  );
  lines.push(`2. Reply with a concise 1-sentence summary of what you changed.`);

  return lines.join('\n');
}
