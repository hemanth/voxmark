import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.html', '.css', '.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', '.git', '.quick-feedback', 'dist', 'build', '.next', 'renders', 'videos', 'extension']);

function collectCandidateFiles(targetDir, url = '') {
  const candidates = [];
  const demoFile = path.join(targetDir, 'demo', 'index.html');
  const rootIndex = path.join(targetDir, 'index.html');

  if (url.includes('/demo') && fs.existsSync(demoFile)) {
    return [demoFile];
  }
  if (fs.existsSync(rootIndex)) {
    candidates.push(rootIndex);
  }
  if (fs.existsSync(demoFile)) {
    candidates.push(demoFile);
  }

  function walk(dir, depth = 0) {
    if (depth > 3 || candidates.length >= 25) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
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
  return candidates;
}

function extractSearchTokens(annotation) {
  const tokens = [];
  const sel = (annotation.selector || '').trim();
  if (sel) {
    tokens.push(sel);
    const idMatch = sel.match(/#[a-zA-Z0-9_-]+/);
    if (idMatch) {
      tokens.push(idMatch[0]);
      tokens.push(`id="${idMatch[0].slice(1)}"`);
    }
    const classMatches = sel.match(/\.[a-zA-Z0-9_-]+/g) || [];
    for (const cls of classMatches) {
      tokens.push(cls);
      tokens.push(cls.slice(1));
    }
  }
  if (annotation.textPreview && annotation.textPreview.trim().length >= 3) {
    tokens.push(annotation.textPreview.trim().slice(0, 40));
  }
  return [...new Set(tokens.filter(Boolean))];
}

function resolveSourceSnippets(annotations, targetDir, url) {
  const files = collectCandidateFiles(targetDir, url);
  const snippets = [];

  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fileLines = content.split('\n');
    const matchedRanges = [];

    for (const ann of annotations) {
      const tokens = extractSearchTokens(ann);
      for (const token of tokens) {
        for (let i = 0; i < fileLines.length; i++) {
          if (fileLines[i].includes(token)) {
            const start = Math.max(1, i + 1 - 3);
            const end = Math.min(fileLines.length, i + 1 + 22);
            matchedRanges.push({ start, end });
          }
        }
        if (matchedRanges.length >= 4) break;
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
      const slice = fileLines
        .slice(range.start - 1, range.end)
        .map((line, idx) => `${range.start + idx}: ${line}`)
        .join('\n');
      snippets.push({
        file,
        startLine: range.start,
        endLine: range.end,
        numberedText: slice
      });
    }
  }

  return snippets.slice(0, 6);
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
  lines.push(`The user recorded live voice and DOM annotations on the running web app.`);
  lines.push(`CRITICAL SPEED INSTRUCTION: Execute the edit in a SINGLE turn using \`replace_file_content\`. Because the exact 1-indexed source lines are pre-resolved below, DO NOT call \`view_file\`, \`list_dir\`, or \`grep_search\` first unless the target code is missing from the pre-resolved snippets.`);
  lines.push('');
  lines.push(`## Page Context`);
  lines.push(`- **URL**: ${url}`);

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
      const instruction = (item.transcript || item.note || '').trim() || '(Refer to full voice transcript above for this highlighted area)';
      lines.push(`### #${num} — ${item.kind ? `[${item.kind.toUpperCase()}] ` : ''}\`${item.selector || item.tagName || 'region'}\``);
      lines.push(`- **Spoken / Annotated Instruction**: "${instruction}"`);

      if (item.componentName) {
        lines.push(`- **Component**: \`${item.componentName}\``);
      }
      if (item.tagName) {
        lines.push(`- **Element Tag**: \`<${item.tagName.toLowerCase()}>\`${item.textPreview ? ` — Text: "${item.textPreview}"` : ''}`);
      }
      if (item.bounds) {
        lines.push(`- **Screen Region**: \`x=${Math.round(item.bounds.x)}, y=${Math.round(item.bounds.y)}, w=${Math.round(item.bounds.width)}, h=${Math.round(item.bounds.height)}\``);
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
    lines.push(`Each line below is prefixed with \`<line_number>: \`. Strip the \`<line_number>: \` prefix when passing \`TargetContent\` to \`replace_file_content\`:`);
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
    lines.push(`The running browser tab exposes ${webmcpTools.length} live WebMCP tool(s) via \`POST ${bridgeUrl}/api/webmcp/call\` with JSON body \`{"name":"<tool>","arguments":{...}}\`:`);
    webmcpTools.forEach((t) => {
      lines.push(`- **\`${t.name}\`** (${t.source || 'app'}): ${t.description || 'In-page WebMCP tool'}`);
    });
    lines.push('');
  }

  lines.push(`## Action Required`);
  lines.push(`1. Immediately call \`replace_file_content\` on the pre-resolved source file lines above.`);
  lines.push(`2. Reply with a 1-sentence summary of what you changed.`);

  return lines.join('\n');
}
