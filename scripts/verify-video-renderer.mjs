// Runs the Windows app with generated sources and its own data and WebView2 profile.
// npm run build first, then run this script with native or canvas as its argument.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const mode = process.argv[2];
assert(process.platform === 'win32' && ['native', 'canvas'].includes(mode), 'Usage on Windows: node scripts/verify-video-renderer.mjs native|canvas');
const root = resolve(import.meta.dirname, '..');
const work = join(root, '.tools', 'renderer-qa');
const run = join(work, `${mode}-${Date.now()}`);
const data = join(run, 'data');
const media = join(data, 'media-cache');
const ffmpeg = join(root, 'tools', 'ffmpeg.exe');
const appPath = process.env.VIEWSICAL_TEST_EXECUTABLE || join(process.env.CARGO_TARGET_DIR || join(root, 'src-tauri', 'target'), 'debug', 'tubedesk.exe');
const exec = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const children = [];
const checks = [];
const analyses = [];
let app, browser, page, pipe;

function start(file, args, options = {}) {
  const child = spawn(file, args, { cwd: root, windowsHide: true, ...options });
  children.push(child);
  return child;
}

async function until(read, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; }
    catch (error) { if (error.fatal) throw error; lastError = error; }
    await delay(65);
  }
  throw new Error(`${label} timed out${lastError ? ` (${lastError.message})` : ''}`);
}

const ipc = (command, args = {}) => page.evaluate(
  ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args },
);

async function playing() {
  return until(async () => {
    const state = await ipc('player_state');
    if (state.status === 'failed') throw Object.assign(new Error(`${state.errorCode} ${state.error}`), { fatal: true });
    return state.status === 'playing' && state.position > 0.15 && state;
  }, 'local fixture playing');
}

async function hasFile(file) {
  try { return (await stat(file)).size > 0; } catch { return false; }
}

async function fixtures() {
  const entries = [];
  const fixtureAudio = join(work, 'tone.mka');
  if (!await hasFile(fixtureAudio)) {
    await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=430:sample_rate=48000:duration=20', '-c:a', 'libopus', fixtureAudio]);
  }
  const items = [];
  for (const [id, quality] of [['viewsync108', 1080], ['viewsync216', 2160]]) {
    const width = quality / 9 * 16;
    const file = join(work, `${quality}p60.mkv`);
    if (!await hasFile(file)) {
      const filters = `hue=s=0,drawbox=x=0:y=ih*0.60:w=iw:h=ih*0.035:color=0x00ffff:t=fill`;
      await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${quality}:rate=60:duration=20`, '-vf', filters, '-threads', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', file], { timeout: 240000 });
    }
    const item = { id, kind: 'video', title: `Scroll QA ${quality}p60`, channel: 'Generated local fixture', thumbnail: null, url: `https://www.youtube.com/watch?v=${id}`, duration: 20, viewCount: null, description: null, youtubeLoudnessDb: 6, heatmap: [{ startTime: 0, endTime: 9, value: 0.1 }, { startTime: 9, endTime: 20, value: 0.9 }] };
    for (const [entryMode, suffix, source] of [['video', 'v.mkv', file], ['audio', 'a.mka', fixtureAudio]]) {
      const uuid = randomUUID();
      const local = `${uuid}-${suffix}`;
      await copyFile(source, join(media, local));
      entries.push({ id: uuid, video: item, mode: entryMode, quality: entryMode === 'video' ? quality : 0, qualities: [quality], file: local, bytes: (await stat(source)).size, duration: 20, lastAccessed: Math.floor(Date.now() / 1000), account: false, retired: false });
    }
    items.push({ item, quality });
  }
  await writeFile(join(media, 'index.json'), JSON.stringify({ enabled: true, maxBytes: 1024 * 1024 * 1024, entries }));
  return items;
}

async function samples() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', `
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add(${app.pid})
    do {
      $before = $ids.Count
      foreach ($p in $all) { if ($ids.Contains($p.ParentProcessId)) { [void]$ids.Add($p.ProcessId) } }
    } while ($ids.Count -gt $before)
    $cpu = Get-Process -Id ([int[]]$ids) -ErrorAction SilentlyContinue | Measure-Object CPU -Sum
    $gpu = @((Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue) | Where-Object { $_.Name -match '^pid_([0-9]+)_' -and $ids.Contains([int]$Matches[1]) -and $_.UtilizationPercentage -gt 0 } | Select-Object Name,UtilizationPercentage)
    $refresh = (Get-CimInstance Win32_VideoController | Measure-Object CurrentRefreshRate -Maximum).Maximum
    @{ cpu = $cpu.Sum; gpu = $gpu; refresh = $refresh; cores = [Environment]::ProcessorCount } | ConvertTo-Json -Depth 3 -Compress
  `], { windowsHide: true });
  return JSON.parse(stdout);
}

async function mpvProperties() {
  if (!pipe) {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq ${app.pid} | Select-Object -ExpandProperty CommandLine`], { windowsHide: true });
    const path = stdout.match(/\\\\\.\\pipe\\[\w-]+/)?.[0];
    assert(path, 'Playback subprocess exposes its local mpv test pipe');
    pipe = net.createConnection(path);
    await new Promise((resolve, reject) => { pipe.once('connect', resolve); pipe.once('error', reject); });
  }
  const properties = ['frame-drop-count', 'decoder-frame-drop-count', 'avsync', 'estimated-vf-fps', 'hwdec-current', 'video-params', 'volume-gain', 'audio-out-params'];
  return new Promise((resolve, reject) => {
    const values = {};
    let buffered = '';
    let received = 0;
    function consume(chunk) {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (message.request_id > 0 && message.request_id <= properties.length) {
          values[properties[message.request_id - 1]] = message.data ?? null;
          if (++received === properties.length) {
            clearTimeout(timeout);
            pipe.off('data', consume);
            resolve(values);
          }
        }
      }
    }
    const timeout = setTimeout(() => { pipe.off('data', consume); reject(new Error('mpv property queries did not return')); }, 5000);
    pipe.on('data', consume);
    pipe.write(properties.map((name, index) => JSON.stringify({ command: ['get_property', name], request_id: index + 1 })).join('\n') + '\n');
  });
}

async function desktopOrigin() {
  const { stdout } = await exec('python', ['-c', `
import ctypes as c, ctypes.wintypes as w, json
u = c.windll.user32
u.SetProcessDpiAwarenessContext(c.c_void_p(-4))
u.ClientToScreen.argtypes = [w.HWND, c.POINTER(w.POINT)]
u.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
u.SetWindowPos.argtypes = [w.HWND, w.HWND, c.c_int, c.c_int, c.c_int, c.c_int, w.UINT]
u.SetForegroundWindow.argtypes = [w.HWND]
u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
def visit(hwnd, _):
    owner = w.DWORD()
    u.GetWindowThreadProcessId(hwnd, c.byref(owner))
    title = c.create_unicode_buffer(256)
    u.GetWindowTextW(hwnd, title, len(title))
    if owner.value != ${app.pid} or title.value != 'Viewsical': return True
    # Keep the isolated app visible during GDI capture, even if another
    # application acquired activation when the test runner started.
    if not u.SetWindowPos(hwnd, w.HWND(-1), 0, 0, 0, 0, 0x0001 | 0x0002):
        raise c.WinError()
    u.SetForegroundWindow(hwnd)
    point = w.POINT()
    u.ClientToScreen(hwnd, c.byref(point))
    print(json.dumps({'x': point.x, 'y': point.y, 'w': u.GetSystemMetrics(0), 'h': u.GetSystemMetrics(1)}))
    return False
u.EnumWindows(c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)(visit), 0)
`], { windowsHide: true });
  return JSON.parse(stdout);
}

function measurePixels(area, seconds, rate) {
  const { x, y, width, height } = area;
  // Each captured row contains just a two-pixel strip of video and of page.
  const columns = `[0:v]split[a][b];[a]crop=2:${height}:0:0[left];[b]crop=2:${height}:${width - 2}:0[right];[left][right]hstack[out]`;
  const child = start(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-video_size', `${width}x${height}`, '-offset_x', String(x), '-offset_y', String(y), '-framerate', String(rate), '-draw_mouse', '0', '-f', 'gdigrab', '-i', 'desktop', '-filter_complex', columns, '-map', '[out]', '-t', String(seconds), '-f', 'rawvideo', '-pix_fmt', 'bgra', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const frames = [];
  const frameBytes = height * 16;
  let pending = Buffer.alloc(0);
  let errors = '';
  let first;
  const started = new Promise(resolve => { first = resolve; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      let video = -1;
      let marker = -1;
      let content = 0;
      for (let row = 0; row < height; row++) {
        const left = row * 16;
        const right = left + 8;
        const matches = (offset, magenta) => frame[offset] > 170 && frame[offset + (magenta ? 2 : 1)] > 170 && frame[offset + (magenta ? 1 : 2)] < 100;
        if (video < 0 && matches(left, false) && matches(left + 4, false)) video = row;
        if (marker < 0 && matches(right, true) && matches(right + 4, true)) marker = row;
        if (row % 4 === 0) content = Math.imul(content, 31) ^ frame[left];
      }
      frames.push({ video, marker, content });
      first();
    }
  });
  const finished = new Promise((resolve, reject) => {
    child.once('close', code => {
      if (code === 0) resolve(frames);
      else reject(new Error(`Desktop capture failed (${code}) ${errors}`));
    });
  });
  return { started: Promise.race([started, finished]), finished };
}

async function scrollSample(paused, rate) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const layout = await page.evaluate(() => {
    const surface = document.querySelector('.full-player .player-surface');
    const neighbor = document.querySelector('.watch-aside');
    const rect = surface.getBoundingClientRect();
    const aside = neighbor.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const marker = document.querySelector('#scroll-probe-mark') || document.createElement('div');
    const tail = document.querySelector('#scroll-probe-tail') || document.createElement('div');
    marker.id = 'scroll-probe-mark';
    tail.id = 'scroll-probe-tail';
    neighbor.style.position = 'relative';
    Object.assign(marker.style, { position: 'absolute', left: '8px', top: `${rect.top + rect.height * 0.60 - aside.top}px`, height: `${rect.height * 0.035}px`, width: '20px', zIndex: 3, background: '#ff00ff', pointerEvents: 'none' });
    tail.style.height = '160vh';
    if (!tail.isConnected) document.querySelector('.watch-main').append(tail);
    if (!marker.isConnected) neighbor.append(marker);
    return { left: rect.left + rect.width * 0.6, right: aside.left + 17, top: topbar.bottom - 6, bottom: Math.min(rect.bottom + 5, innerHeight - 5), scale: devicePixelRatio, startY: topbar.bottom + 6, range: rect.top + rect.height * 0.60 - topbar.bottom - 12 };
  });
  const origin = await desktopOrigin();
  const x = Math.round(origin.x + layout.left * layout.scale);
  const y = Math.round(origin.y + layout.top * layout.scale);
  const width = 2 + Math.round(origin.x + layout.right * layout.scale) - x;
  const height = Math.min(origin.h - y, Math.round(origin.y + layout.bottom * layout.scale) - y);
  assert(x >= 0 && y >= 0 && width > 2 && height > 100 && x + width <= origin.w, 'Maximized app and both strips are on the primary monitor');
  await page.mouse.move(layout.right, layout.startY);
  const capture = measurePixels({ x, y, width, height }, 6, rate);
  await capture.started;
  await delay(1200);
  // Send small precision-wheel deltas and fast wheel motion outside the player.
  const slow = Math.max(2, Math.floor(layout.range / 33));
  for (const step of [slow, -slow, slow * 4, -slow * 4]) {
    const count = Math.abs(step) === slow ? 30 : 8;
    for (let index = 0; index < count; index++) {
      await page.mouse.wheel(0, step);
      await delay(Math.abs(step) === slow ? 14 : 24);
    }
    await delay(160);
  }
  // Hold one position where the header cuts through both color bands.
  await page.evaluate(offset => window.scrollTo(0, offset), layout.range + 17);
  await delay(250);
  await page.evaluate(() => window.scrollTo(0, 0));
  const frames = await capture.finished;
  const measurable = frames.filter(frame => frame.video >= 0 && frame.marker >= 0);
  assert(measurable.length >= 60, `Desktop sample saw ${frames.filter(frame => frame.video >= 0).length} video and ${frames.filter(frame => frame.marker >= 0).length} marker frames out of ${frames.length}`);
  const staticOffsets = frames.slice(0, 12).filter(frame => frame.video >= 0 && frame.marker >= 0).map(frame => frame.video - frame.marker).sort((a, b) => a - b);
  const zero = staticOffsets[Math.floor(staticOffsets.length / 2)];
  assert(Number.isFinite(zero), 'Both screen markers are visible before input');
  const clipped = measurable.filter(frame => frame.marker === Math.min(...measurable.map(frame => frame.marker)));
  const moving = measurable.filter((frame, index) => index && (frame.marker !== measurable[index - 1].marker || frame.video !== measurable[index - 1].video));
  const residual = moving.map(({ video, marker }) => Math.abs(video - marker - zero)).sort((a, b) => a - b);
  const stationary = frames.slice(Math.round(rate * 0.1), rate);
  const visualChangesPerSecond = stationary.filter((frame, index) => index && frame.content !== stationary[index - 1].content).length / 0.9;
  const result = { paused, rate, captured: frames.length, measurable: measurable.length, moving: moving.length, clipped: clipped.length, p95: residual[Math.floor(residual.length * 0.95)], max: residual.at(-1), exceedingTwoPixels: residual.filter(value => value > 2).length, visualChangesPerSecond, offsets: frames.map(({ video, marker }) => [video, marker]) };
  assert(moving.length >= 30 && clipped.length > 0, 'Real desktop samples must include moving and clipped video');
  return result;
}

async function canvasInteractions({ item, quality }) {
  await ipc('play_video', { item, quality, playbackMode: 'video' });
  await playing();
  await ipc('player_action', { action: 'seek', value: 7 });
  await ipc('player_action', { action: 'pause' });
  const video = page.locator('.full-player .is-canvas-video');
  await video.hover({ position: { x: 40, y: 40 } });
  await video.locator('.seek-heatmap').waitFor({ state: 'visible' });
  await video.getByRole('button', { name: 'Theater mode', exact: true }).click();
  await page.locator('.app.theater-mode').waitFor();
  await video.hover({ position: { x: 42, y: 42 } });
  await video.getByRole('button', { name: 'Exit theater mode', exact: true }).click();
  await page.locator('.app.theater-mode').waitFor({ state: 'detached' });
  await video.hover({ position: { x: 44, y: 44 } });
  await video.getByRole('button', { name: 'Fullscreen (F)', exact: true }).click();
  await page.locator('.app.player-fullscreen').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.app.player-fullscreen').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Listen with audio only', exact: true }).click();
  await until(async () => {
    const state = await ipc('player_state');
    return state.playbackMode === 'audio' && state.status === 'paused' && state.position >= 6.5;
  }, 'audio mode switches at the paused position');
  await page.locator('.full-player .audio-stage').hover({ position: { x: 40, y: 40 } });
  await page.locator('.full-player .audio-overlay-controls .seek-heatmap').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Switch to video', exact: true }).click();
  const before = await until(async () => {
    const state = await ipc('player_state');
    return state.playbackMode === 'video' && state.status === 'paused' && state.position >= 6.5 && state;
  }, 'video mode switches at the paused position');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.locator('.mini-player .is-canvas-video').waitFor();
  await page.getByRole('button', { name: 'Move player to bottom bar', exact: true }).click();
  await page.locator('.bottom-player .bottom-player-content').waitFor();
  await page.getByRole('button', { name: 'Restore floating mini player', exact: true }).click();
  await page.getByRole('button', { name: 'Expand player', exact: true }).click();
  assert.equal((await ipc('player_state')).loadId, before.loadId);
  checks.push('Canvas fullscreen, theater, mini-player, docking, audio/video switching and replay graphs');

  await video.locator('canvas').evaluate(canvas => {
    const lose = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!lose) throw Error('WebView2 does not expose a WebGL loss injection extension');
    lose.loseContext();
  });
  await video.waitFor({ state: 'detached' });
  const restored = await until(async () => {
    const state = await ipc('player_state');
    return state.status === 'paused' && state.position >= 6.5 && state;
  }, 'native fallback resumes at the paused position');
  const overlay = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => !candidate.isClosed() && candidate.url().includes('player-overlay')), 'native controls after context loss');
  await overlay.locator('.player-overlay-root').waitFor();
  assert.equal(restored.video.id, before.video.id);
  assert.equal(restored.requestedQuality, before.requestedQuality);
  assert(Math.abs(restored.position - before.position) < 0.7, 'Context loss preserves the current position');
  checks.push('Real WebGL context loss switches to native video and preserves the paused item, position and quality');
}

try {
  await mkdir(media, { recursive: true });
  const clips = await fixtures();
  const vite = start(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', '1420', '--strictPort'], { stdio: 'ignore' });
  await until(async () => (await fetch('http://127.0.0.1:1420')).ok && vite.exitCode === null, 'Vite preview');
  const port = process.env.VIEWSICAL_TEST_CDP_PORT || '9359';
  app = start(appPath, [], { windowsHide: false, env: { ...process.env, TUBEDESK_DATA_DIR: data, TUBEDESK_VIDEO_RENDERER: mode === 'native' ? 'native' : undefined, WEBVIEW2_USER_DATA_FOLDER: join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stderr.on('data', chunk => process.stderr.write(chunk));
  app.stdout.on('data', chunk => process.stdout.write(chunk));
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok, 'isolated Windows app');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => {
    const url = candidate.url();
    return !url.includes('player-overlay') && (url.includes('1420') || url.startsWith('http://tauri.localhost') || url.startsWith('tauri:'));
  }), 'main WebView');
  await page.locator('#search').waitFor();
  const boot = await ipc('bootstrap');
  await ipc('save_settings', { settings: { ...boot.settings, theme: 'dark', volume: 8, muted: true, alwaysAudioOnly: false } });
  if (!await ipc('plugin:window|is_maximized', { label: 'main' })) await ipc('plugin:window|toggle_maximize', { label: 'main' });
  if (mode === 'canvas' && process.env.VIEWSICAL_TEST_INTERACTIONS_ONLY) {
    await ipc('play_video', { ...clips[0], playbackMode: 'video' });
    await playing();
    await page.getByRole('button', { name: 'Return to player', exact: true }).click();
    await desktopOrigin();
  }
  for (const { item, quality } of process.env.VIEWSICAL_TEST_INTERACTIONS_ONLY ? [] : clips) {
    const startTime = performance.now();
    await ipc('play_video', { item, quality, playbackMode: 'video' });
    const opened = await playing();
    console.log('Loaded', quality, opened.position, await ipc('video_renderer_mode').catch(() => null));
    assert(opened.position < 2);
    if (!await page.locator('.full-player .player-surface').count()) await page.getByRole('button', { name: 'Return to player', exact: true }).click();
    await page.locator('.watch-aside').waitFor();
    if (mode === 'canvas') await page.locator('.is-canvas-video .video-frame-canvas').waitFor();
    const startupMs = Math.round(performance.now() - startTime);
    const initial = await mpvProperties();
    assert.equal(initial['video-params']?.h, quality);
    assert.equal(initial['volume-gain'], -6);
    assert(initial['audio-out-params']?.format);
    const cpuStart = await samples();
    const captureRate = Number(process.env.VIEWSICAL_TEST_CAPTURE_RATE || cpuStart.refresh || 60);
    const before = performance.now();
    const moving = await scrollSample(false, captureRate);
    const after = await samples();
    const elapsed = (performance.now() - before) / 1000;
    const observed = await mpvProperties();
    await ipc('player_action', { action: 'pause' });
    const paused = await scrollSample(true, captureRate);
    const analysis = { quality, startupMs, processTreeCpuPercent: (after.cpu - cpuStart.cpu) / elapsed / after.cores * 100, gpuEngines: after.gpu, initial, observed, moving, paused };
    analyses.push(analysis);
    const short = ({ offsets, ...summary }) => summary;
    console.log(JSON.stringify({ ...analysis, moving: short(moving), paused: short(paused) }));
    if (mode === 'canvas') assert(moving.max <= 2 && paused.max <= 2, 'Displayed video and neighboring page move within two physical pixels');
    await ipc('player_action', { action: 'seek', value: 19.4 });
    await ipc('player_action', { action: 'toggle' });
    await until(async () => (await ipc('player_state')).status === 'ended', 'natural end of queue');
    assert.equal((await ipc('player_state')).error, null);
    await ipc('player_action', { action: 'toggle' });
    assert((await playing()).position < 2, 'Replay starts from the beginning');
    checks.push(`${quality}p60 playback, scrolling, queue end and replay`);
  }
  if (mode === 'canvas') await canvasInteractions(clips[0]);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(run, 'results.json'), JSON.stringify({ mode, checks, analyses, passed: !process.exitCode }, null, 2));
  console.log(`Desktop verification results: ${join(run, 'results.json')}`);
  pipe?.destroy();
  if (app?.exitCode === null && page) {
    try { await ipc('plugin:window|close', { label: 'main' }); await until(() => app.exitCode !== null, 'app shutdown', 10000); } catch { /* owned processes are killed below */ }
  }
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) if (child.exitCode === null) child.kill();
}
