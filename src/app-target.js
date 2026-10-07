import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const STATIC_SEARCH_IGNORED = new Set([
  'node_modules',
  '.git',
  '.quick-feedback',
  'demo',
  'test',
  'tests',
  'coverage',
  'extension'
]);

const staticRootsCache = new Map();
const listeningPortCache = new Map();
const CACHE_TTL_MS = 2000;

export function injectOverlayIntoHtml(html, bridgeOrigin) {
  if (!html || typeof html !== 'string') return html;
  if (html.includes('/overlay.js') || html.includes('__QUICK_FEEDBACK_LOADED__')) {
    return html;
  }
  const tag = `<script src="${bridgeOrigin}/overlay.js"></script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${tag}\n</body>`);
  }
  if (/<\/html>/i.test(html)) {
    return html.replace(/<\/html>/i, `${tag}\n</html>`);
  }
  return `${html}\n${tag}`;
}

const NON_APP_SERVER_PROCESS_RE =
  /^(agy|language_server|claude|codex|gemini|cursor|code|windsurf|zed|electron|google|chrome|safari|firefox|arc|brave|git|ssh|gpg|docker|com\.docker|postgres|mysqld|redis|mongod|ollama|adb|rapportd|controlcenter|mdnsresponder)/i;

export function isIgnoredListeningProcessName(commandName = '') {
  const clean = String(commandName || '').trim();
  if (!clean) return false;
  return NON_APP_SERVER_PROCESS_RE.test(clean);
}

export function detectListeningPortByCwd(targetDir, excludePort, { useCache = false } = {}) {
  const cacheKey = `${targetDir}:${excludePort}`;
  if (useCache) {
    const cached = listeningPortCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.value;
    }
  }

  let foundUrl = null;
  try {
    const normalizedTarget = fs.realpathSync(targetDir);
    const listenOut = execFileSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fpcn'], {
      encoding: 'utf8',
      timeout: 1200,
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const pidToPorts = new Map();
    let currentPid = null;
    let currentCmd = '';
    for (const line of listenOut.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = line.slice(1).trim();
        currentCmd = '';
      } else if (line.startsWith('c')) {
        currentCmd = line.slice(1).trim();
      } else if (line.startsWith('n') && currentPid) {
        if (Number(currentPid) === process.pid || isIgnoredListeningProcessName(currentCmd)) {
          continue;
        }
        const match = line.match(/:(\d+)$/);
        if (match) {
          const p = Number(match[1]);
          if (p && p !== excludePort) {
            if (!pidToPorts.has(currentPid)) pidToPorts.set(currentPid, []);
            pidToPorts.get(currentPid).push(p);
          }
        }
      }
    }

    if (pidToPorts.size > 0) {
      const pids = [...pidToPorts.keys()];
      const cwdOut = execFileSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        timeout: 1200,
        stdio: ['ignore', 'pipe', 'ignore']
      });

      let checkPid = null;
      for (const line of cwdOut.split('\n')) {
        if (line.startsWith('p')) {
          checkPid = line.slice(1).trim();
        } else if (line.startsWith('n') && checkPid) {
          const procCwd = line.slice(1).trim();
          let realProcCwd = procCwd;
          try {
            realProcCwd = fs.realpathSync(procCwd);
          } catch {}
          if (
            realProcCwd === normalizedTarget ||
            realProcCwd.startsWith(normalizedTarget + path.sep)
          ) {
            const ports = pidToPorts.get(checkPid) || [];
            if (ports.length > 0) {
              foundUrl = `http://127.0.0.1:${ports[0]}`;
              break;
            }
          }
        }
      }
    }
  } catch {
    // Ignore lsof errors on unsupported platforms
  }

  listeningPortCache.set(cacheKey, { ts: Date.now(), value: foundUrl });
  return foundUrl;
}

export function detectDevScript(targetDir) {
  const pkgPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.dev) return 'dev';
    if (scripts.serve) return 'serve';
    if (
      scripts.start &&
      /(vite|next|react-scripts|astro|nuxt|svelte|webpack|parcel|http-server|serve|ng\s+serve)/i.test(
        scripts.start
      )
    ) {
      return 'start';
    }
  } catch {}
  return null;
}

export function detectPackageManager(targetDir) {
  if (fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(targetDir, 'bun.lockb')) || fs.existsSync(path.join(targetDir, 'bun.lock'))) {
    return 'bun';
  }
  return 'npm';
}

export function spawnAppDevServer(targetDir, excludePort, onUrlDetected) {
  const scriptName = detectDevScript(targetDir);
  if (!scriptName) return Promise.resolve({ child: null, url: null });

  const pm = detectPackageManager(targetDir);
  return new Promise((resolve) => {
    let settled = false;
    let detectedUrl = null;
    const child = spawn(pm, ['run', scriptName], {
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' }
    });

    const handleOutput = (chunk) => {
      const clean = chunk.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      const urlMatch = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)/i);
      if (urlMatch) {
        const portNum = Number(urlMatch[1]);
        if (portNum && portNum !== excludePort) {
          detectedUrl = `http://127.0.0.1:${portNum}`;
          if (typeof onUrlDetected === 'function') onUrlDetected(detectedUrl);
          if (!settled) {
            settled = true;
            clearInterval(pollTimer);
            clearTimeout(timeoutTimer);
            resolve({ child, url: detectedUrl });
          }
        }
      }
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);

    const pollTimer = setInterval(() => {
      const byCwd = detectListeningPortByCwd(targetDir, excludePort);
      if (byCwd) {
        detectedUrl = byCwd;
        if (typeof onUrlDetected === 'function') onUrlDetected(detectedUrl);
        if (!settled) {
          settled = true;
          clearInterval(pollTimer);
          clearTimeout(timeoutTimer);
          resolve({ child, url: detectedUrl });
        }
      }
    }, 250);

    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(pollTimer);
        resolve({ child, url: detectedUrl });
      }
    }, 5500);

    child.once('error', () => {
      if (!settled) {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        resolve({ child: null, url: null });
      }
    });

    child.once('exit', () => {
      if (!settled) {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        resolve({ child: null, url: detectedUrl });
      }
    });
  });
}

function isUnbundledEntryHtml(targetDir, html) {
  for (const cfg of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    if (fs.existsSync(path.join(targetDir, cfg))) return true;
  }
  const scriptTags = html.match(/<script[^>]+src=["']([^"']+)["']/gi) || [];
  for (const tag of scriptTags) {
    const m = tag.match(/src=["']([^"']+)["']/i);
    if (!m) continue;
    const src = m[1].replace(/^\//, '');
    if (/\.(tsx|ts|jsx|vue|svelte)(\?|$)/i.test(src)) return true;
    const fullPath = path.join(targetDir, src);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const content = fs.readFileSync(fullPath, 'utf8').slice(0, 4000);
      if (/import\s+['"][^'"]+\.css['"]/i.test(content)) return true;
      if (/from\s+['"][^./][^'"]*['"]/i.test(content) && !html.includes('importmap')) return true;
    }
  }
  return false;
}

export function discoverStaticRoots(targetDir) {
  const cached = staticRootsCache.get(targetDir);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.roots;
  }

  const distDir = path.join(targetDir, 'dist');
  const publicDir = path.join(targetDir, 'public');
  const rootIndex = path.join(targetDir, 'index.html');
  const distIndex = path.join(distDir, 'index.html');

  const preferDist =
    fs.existsSync(rootIndex) &&
    fs.existsSync(distIndex) &&
    isUnbundledEntryHtml(targetDir, fs.readFileSync(rootIndex, 'utf8'));

  const roots = preferDist
    ? [distDir, publicDir, targetDir]
    : [targetDir, publicDir, distDir];

  for (const sub of ['src', 'app', 'web', 'client', 'docs', 'www', 'build', 'out']) {
    const subPath = path.join(targetDir, sub);
    if (fs.existsSync(subPath) && !roots.includes(subPath)) {
      roots.push(subPath);
    }
  }

  function walkDirs(dir, depth = 0) {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || STATIC_SEARCH_IGNORED.has(entry.name)) continue;
      const fullDir = path.join(dir, entry.name);
      if (fs.existsSync(path.join(fullDir, 'index.html')) && !roots.includes(fullDir)) {
        roots.push(fullDir);
      }
      walkDirs(fullDir, depth + 1);
    }
  }
  walkDirs(targetDir, 0);

  staticRootsCache.set(targetDir, { ts: Date.now(), roots });
  return roots;
}

function isPathWithinRoot(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

export function resolveStaticFile(targetDir, urlPathname, explicitHtmlFile = null) {
  let decodedPath = '/';
  try {
    decodedPath = decodeURIComponent(urlPathname || '/');
  } catch {
    return null;
  }

  const safeRel = path.posix
    .normalize(decodedPath)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^\/+/, '');

  const searchRoots = discoverStaticRoots(targetDir);

  if (!safeRel || safeRel === '.') {
    if (explicitHtmlFile) {
      const explicitCandidate = path.join(targetDir, explicitHtmlFile);
      if (
        isPathWithinRoot(explicitCandidate, targetDir) &&
        fs.existsSync(explicitCandidate) &&
        fs.statSync(explicitCandidate).isFile()
      ) {
        return explicitCandidate;
      }
    }
    for (const root of searchRoots) {
      const idx = path.join(root, 'index.html');
      if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
    }
    return null;
  }

  for (const root of searchRoots) {
    const candidate = path.join(root, safeRel);
    if (!isPathWithinRoot(candidate, root)) continue;
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
      if (stat.isDirectory()) {
        const idx = path.join(candidate, 'index.html');
        if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
      }
    }
  }

  // Fallback for apps built with a custom base path (e.g. /ai/caption-it/assets/...)
  const parts = safeRel.split('/').filter(Boolean);
  for (let strip = 1; strip < Math.min(parts.length, 4); strip++) {
    const subRel = parts.slice(strip).join('/');
    for (const root of searchRoots) {
      const candidate = path.join(root, subRel);
      if (!isPathWithinRoot(candidate, root)) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return null;
}

export function proxyHttpRequest(req, res, targetOrigin, bridgeOrigin, onFallback = null) {
  const target = new URL(req.url || '/', targetOrigin);
  const client = target.protocol === 'https:' ? https : http;

  const headers = { ...req.headers };
  headers.host = target.host;
  // Request uncompressed upstream response so we can inject /overlay.js into HTML
  headers['accept-encoding'] = 'identity';

  const proxyReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers
    },
    (proxyRes) => {
      const contentType = String(proxyRes.headers['content-type'] || '');
      const isHtml = contentType.includes('text/html');
      const isRoot404 =
        proxyRes.statusCode === 404 && (req.url === '/' || req.url === '') && req.method === 'GET';
      const isBadRequest = proxyRes.statusCode === 400;

      if (isHtml || isRoot404 || isBadRequest) {
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');

          if (
            isBadRequest &&
            /Client sent an HTTP request to an HTTPS server/i.test(bodyText) &&
            typeof onFallback === 'function' &&
            onFallback()
          ) {
            return;
          }

          // If Vite dev server has a non-root base URL (e.g. /ai/caption-it/), auto-redirect / to it
          if (isRoot404) {
            const viteBaseMatch = bodyText.match(/public base URL of (\/[^\s"']+) - did you mean/i);
            if (viteBaseMatch && viteBaseMatch[1] && viteBaseMatch[1] !== '/') {
              res.writeHead(302, { Location: viteBaseMatch[1] });
              res.end();
              return;
            }
          }

          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['content-encoding'];
          outHeaders['cache-control'] = 'no-store';

          const modified = isHtml ? injectOverlayIntoHtml(bodyText, bridgeOrigin) : bodyText;
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          res.end(modified);
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent && typeof onFallback === 'function' && onFallback()) {
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Upstream proxy error (${targetOrigin}): ${err.message}` }));
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq);
}

export function forwardWebSocketUpgrade(req, socket, head, upstreamUrl) {
  if (!upstreamUrl) {
    socket.destroy();
    return;
  }
  try {
    const target = new URL(req.url || '/', upstreamUrl);
    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const proxySocket = net.connect(targetPort, target.hostname, () => {
      const reqHeaders = [`${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        if (k.toLowerCase() === 'host') {
          reqHeaders.push(`Host: ${target.host}`);
        } else {
          reqHeaders.push(`${k}: ${v}`);
        }
      }
      reqHeaders.push('', '');
      proxySocket.write(reqHeaders.join('\r\n'));
      if (head && head.length) proxySocket.write(head);
      socket.pipe(proxySocket).pipe(socket);
    });
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  } catch {
    socket.destroy();
  }
}
