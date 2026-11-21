// Browser-only regression fixtures. Never imported by the application bundle.
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const server = await preview({ root, preview: { host: '127.0.0.1', port: 4174, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const results = [];
const check = (name, passed, detail) => { results.push({ name, passed, detail }); if (!passed) throw new Error(name); };
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const art = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#6c7da2"/><stop offset=".6" stop-color="#243957"/><stop offset="1" stop-color="#131b32"/></linearGradient></defs><path fill="url(#g)" d="M0 0h640v360H0z"/><circle fill="#d8c4ad" cx="490" cy="95" r="47"/><path fill="#405777" d="m0 270 130-145 130 115L420 80l220 210v70H0z"/><path fill="#16263f" d="m0 320 170-135 120 115 115-105 235 140v25H0z"/></svg>')}`;
    const video = index => ({ id: index === 3 || index === 28 ? 'duplicate-id' : `fixture-${index}`, kind: 'video', title: `Fixture video ${String(index).padStart(2, '0')}`, channel: 'Fixture Music', thumbnail: art, url: `https://www.youtube.com/watch?v=fixture${index}`, duration: 190 + index, viewCount: 10000 + index * 153, description: null, playlistIndex: index });
    const playlist = { id: 'PLfixture', kind: 'playlist', title: 'Evening listening', channel: 'Fixture listener', thumbnail: art, url: 'https://www.youtube.com/playlist?list=PLfixture', duration: null, viewCount: null, description: 'A quiet collection for the end of the day.' };
    const collection = { id: 'PLfixture', title: playlist.title, owner: playlist.channel, thumbnail: art, itemCount: 36, description: playlist.description, isMix: false, url: playlist.url };
    const session = { generation: 1, status: 'connected', label: 'Fixture listener', message: null };
    const settings = { theme: 'system', downloadDirectory: 'C:\\Fixture downloads', defaultQuality: 1080, volume: 80, muted: false, playbackRate: 1 };
    let player = { status: 'idle', video: null, position: 0, duration: 0, volume: 80, muted: false, speed: 1, quality: 1080, requestedQuality: 1080, qualities: [1080, 720, 480], error: null, errorCode: null, bufferedSeconds: 30, loadId: 0, playbackMode: 'video' };
    let callbackId = 0; const callbacks = new Map(); const listeners = new Map();
    const state = { calls: [], bounds: null, context: null, emit: (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); } };
    window.__fixture = state;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: handler => { const id = ++callbackId; callbacks.set(id, handler); return id; },
      unregisterCallback: id => callbacks.delete(id),
      invoke: async (command, args = {}) => {
        state.calls.push({ command, args });
        if (command === 'plugin:event|listen') { const id = ++callbackId; listeners.set(id, args); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        if (command === 'bootstrap') return { session, settings, downloads: [], history: [], tools: [] };
        if (command === 'session_state') return session;
        if (command === 'browse') {
          await new Promise(resolve => setTimeout(resolve, 35));
          if (args.kind === 'home') return { items: [playlist, ...Array.from({ length: 40 }, (_, i) => video(i + 1))], nextCursor: null };
          if (args.kind === 'playlists') return { items: [playlist], nextCursor: null };
          if (args.kind === 'playlist') return args.cursor ? { items: Array.from({ length: 12 }, (_, i) => video(i + 25)), nextCursor: null, collection } : { items: Array.from({ length: 24 }, (_, i) => video(i + 1)), nextCursor: 'page-24', collection };
          return { items: [video(1)], nextCursor: null };
        }
        if (command === 'player_state') { if (player.status === 'playing') player = { ...player, position: player.position + 1 }; return player; }
        if (command === 'play_video') { player = { ...player, video: args.item, status: 'playing', loadId: player.loadId + 1, position: args.startSeconds ?? 30, duration: args.item.duration, playbackMode: args.playbackMode ?? player.playbackMode }; state.emit('player-state', player); return; }
        if (command === 'player_action') { if (args.action === 'toggle') player = { ...player, status: player.status === 'playing' ? 'paused' : 'playing' }; else if (args.action === 'speed') player = { ...player, speed: args.value }; else if (args.action === 'stop') player = { ...player, status: 'idle', video: null }; state.emit('player-state', player); return; }
        if (command === 'set_playback_mode') { player = { ...player, playbackMode: args.mode }; state.emit('player-state', player); return; }
        if (command === 'player_ui_context') { state.context = args.context; return; }
        if (command === 'player_bounds') { state.bounds = args.bounds; return; }
        if (command === 'save_settings') { Object.assign(settings, args.settings); return settings; }
        if (command === 'clear_history' || command === 'cancel_browse' || command.startsWith('plugin:window|')) return;
        throw new Error(`Unimplemented fixture command: ${command}`);
      },
    };
  });
  await page.goto('http://127.0.0.1:4174', { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).waitFor();
  const calls = async command => page.evaluate(name => window.__fixture.calls.filter(call => call.command === name), command);
  const homeCount = async () => (await calls('browse')).filter(call => call.args.kind === 'home').length;
  const libraryCount = async () => (await calls('browse')).filter(call => call.args.kind === 'playlists').length;
  check('Home first visit loads once', await homeCount() === 1);
  await page.evaluate(() => scrollTo(0, 610));
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByRole('heading', { name: 'Your playlists', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForFunction(() => window.scrollY > 500);
  check('Home navigation restores cached results and scroll', await homeCount() === 1 && Math.abs(await page.evaluate(() => window.scrollY) - scrollY) < 3);
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).click();
  await page.getByRole('heading', { name: 'Evening listening', exact: true }).waitFor();
  check('Playlists library remains cached', await libraryCount() === 1);
  check('Playlist metadata and first 24 ordered rows', await page.locator('.playlist-row').count() === 24 && await page.locator('.playlist-description-meta').textContent() === 'Playlist · 36 videos');
  await page.screenshot({ path: path.join(output, 'v011-playlist-dark.png'), fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: path.join(output, 'v011-playlist-light.png'), fullPage: false });
  await page.getByRole('button', { name: 'Play Fixture video 03 from this playlist', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 36);
  check('Selected playlist row starts full 36-entry queue', await page.locator('.queue-item.current strong').textContent() === 'Fixture video 03' && (await calls('play_video')).at(-1).args.item.playlistIndex === 3);
  await page.getByRole('button', { name: /Fixture video 28 Fixture Music/ }).click();
  await page.waitForFunction(() => document.querySelector('.queue-item.current strong')?.textContent === 'Fixture video 28');
  check('Duplicate video IDs retain distinct playable occurrences', (await calls('play_video')).at(-1).args.item.playlistIndex === 28);
  const playCount = (await calls('play_video')).length;
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('region', { name: 'Mini player', exact: true }).waitFor();
  check('Navigation keeps persistent mini-player without reloading', (await calls('play_video')).length === playCount && await homeCount() === 1);
  await page.getByRole('button', { name: 'Expand player', exact: true }).click();
  check('Expanding returns to Watch without reloading', (await calls('play_video')).length === playCount);
  await page.getByRole('button', { name: 'Listen with audio only', exact: true }).click();
  await page.getByRole('button', { name: 'Pause audio', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await page.getByRole('button', { name: 'Play audio', exact: true }).waitFor();
  check('Audio-only mode and artwork click pause', (await calls('set_playback_mode')).at(-1).args.mode === 'audio' && (await calls('player_action')).at(-1).args.action === 'toggle');
  await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /Playback speed/ }).click();
  await page.getByRole('menuitemradio', { name: '1.5×', exact: true }).click();
  check('Settings popover speed submenu works', (await calls('player_action')).at(-1).args.value === 1.5);
  await page.getByRole('button', { name: 'Switch to video', exact: true }).click();
  await page.locator('.sidebar-bottom button').focus();
  await page.keyboard.press('Tab');
  await page.locator('.accessible-controls:focus-within').waitFor();
  await page.getByRole('group', { name: 'Accessible player controls', exact: true }).waitFor();
  check('Accessible controls remain available in video mode', await page.getByRole('button', { name: 'Playback settings', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'Evening listening', exact: true }).waitFor();
  check('Returning to playlist retains all loaded pages', await page.locator('.playlist-row').count() === 36 && (await calls('browse')).filter(call => call.args.kind === 'playlist').length === 2);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh videos', exact: true }).click();
  await page.waitForFunction(() => window.__fixture.calls.filter(call => call.command === 'browse' && call.args.kind === 'home').length === 2);
  check('Manual refresh is the only navigation metadata reload', await homeCount() === 2);
  for (const width of [1500, 1024, 700]) { await page.setViewportSize({ width, height: 900 }); check(`No horizontal overflow ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
  check('No browser errors', errors.length === 0, errors);
} catch (error) {
  results.push({ name: 'Smoke completed', passed: false, detail: String(error) });
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'v011-frontend-fixture-results.json'), JSON.stringify({ checks: results, passed: results.every(result => result.passed) }, null, 2));
  console.log(JSON.stringify({ checks: results, passed: results.every(result => result.passed) }, null, 2));
  await browser.close(); await new Promise(resolve => server.httpServer.close(resolve));
}
