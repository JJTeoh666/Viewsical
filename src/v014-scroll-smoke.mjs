// Browser-only regression fixtures. Never imported by the application bundle.
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const server = await preview({ root, preview: { host: '127.0.0.1', port: 4178, strictPort: true } });
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
    const collection = { id: 'PLfixture', title: playlist.title, owner: playlist.channel, thumbnail: art, itemCount: 120, description: playlist.description, isMix: false, url: playlist.url };
    const MiB = 1024 ** 2;
    const cacheData = { enabled: true, maxBytes: 2 * 1024 ** 3, totalBytes: 120 * MiB, audioBytes: 16 * MiB, videoBytes: 96 * MiB, pendingBytes: 8 * MiB, entryCount: 3, activeCount: 1, entries: [
      { id: 'cached-audio', videoId: 'audio', title: 'Fixture cached audio', mode: 'audio', quality: 0, bytes: 16 * MiB, lastAccessed: 1780000000, pinned: false },
      { id: 'cached-video', videoId: 'video', title: 'Fixture cached video', mode: 'video', quality: 720, bytes: 64 * MiB, lastAccessed: 1780000000, pinned: false },
      { id: 'playing-cache', videoId: 'playing', title: 'Fixture currently playing', mode: 'video', quality: 1080, bytes: 32 * MiB, lastAccessed: 1780000000, pinned: true },
    ] };
    const session = { generation: 1, status: 'connected', label: 'Fixture listener', message: null };
    const settings = { theme: 'system', downloadDirectory: 'C:\\Fixture downloads', defaultQuality: 1080, volume: 80, muted: false, playbackRate: 1, alwaysAudioOnly: false };
    let player = { status: 'idle', video: null, position: 0, duration: 0, volume: 80, muted: false, speed: 1, quality: 1080, requestedQuality: 1080, qualities: [1080, 720, 480], error: null, errorCode: null, bufferedSeconds: 30, loadId: 0, playbackMode: 'video' };
    let callbackId = 0; const callbacks = new Map(); const listeners = new Map();
    const state = { calls: [], bounds: null, context: null, emit: (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); } };
    state.endVideo = () => { player = {...player,status:'ended'}; state.emit('player-state',player); };
    window.__fixture = state; state.cache = cacheData; state.session = session;
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
          if (args.kind === 'home') { const offset = Number(args.cursor ?? 0); return { items: [...(offset === 0 ? [playlist] : []), ...Array.from({ length: 24 }, (_, i) => video(i + offset + 1))], nextCursor: offset < 48 ? String(offset+24) : null }; }
          if (args.kind === 'playlists') return { items: [playlist], nextCursor: null };
          if (args.kind === 'playlist') { const offset = Number(args.cursor ?? 0); if (state.failNextPlaylist && offset > 0) { state.failNextPlaylist = false; throw {message: 'Fixture network interruption'}; } return { items: Array.from({ length: 24 }, (_, i) => video(i+offset+1)), nextCursor: offset < 96 ? String(offset+24) : null, collection }; }
          return { items: [video(1)], nextCursor: null };
        }
        if (command === 'cache_summary') return structuredClone(cacheData);
        if (command === 'cache_configure') { cacheData.enabled = args.enabled; cacheData.maxBytes = args.maxBytes; state.emit('cache-changed', structuredClone(cacheData)); return structuredClone(cacheData); }
        if (command === 'cache_clear') {
          cacheData.entries = cacheData.entries.filter(file => file.pinned || !(args.entryId ? file.id === args.entryId : args.kind === 'all' || file.mode === args.kind));
          cacheData.audioBytes = cacheData.entries.filter(file => file.mode === 'audio').reduce((sum,file) => sum+file.bytes,0);
          cacheData.videoBytes = cacheData.entries.filter(file => file.mode === 'video').reduce((sum,file) => sum+file.bytes,0);
          cacheData.pendingBytes = 0; cacheData.activeCount = 0; cacheData.totalBytes = cacheData.audioBytes + cacheData.videoBytes; cacheData.entryCount = cacheData.entries.length;
          cacheData.activeCount = 0; state.emit('cache-changed', structuredClone(cacheData)); return structuredClone(cacheData);
        }
        if (command === 'video_comments') {
          await new Promise(resolve => setTimeout(resolve,30));
          if (args.videoId === 'fixture-5') return { videoId: args.videoId, items: [], nextCursor: null, totalCount: null, disabled: true, sort: args.sort, limited: false };
          const start = args.cursor ? 20 : 0; const count = args.sort === 'newest' ? 2 : args.cursor ? 3 : 20;
          return { videoId: args.videoId, items: Array.from({ length: count },(_,index) => ({ id: `${args.videoId}-${args.sort}-${start+index}`, author: args.sort === 'newest' ? `Newest viewer ${index+1}` : `Viewer ${start+index+1}`, authorThumbnail: null, text: start+index===0 ? 'Literal <script>window.__commentInjected=true</script> stays plain text. '+('A thoughtful comment about this video. '.repeat(15)) : `A comment on this video, number ${start+index+1}.`, likeCount: index*3, replyCount: index===1?2:null, published: '2 days ago', authorIsUploader: index===1, isPinned: index===0 && args.sort==='top' })), nextCursor: args.sort==='top'&&!args.cursor?'comments-next':null, totalCount:23, disabled:false, sort:args.sort, limited:false };
        }
        if (command === 'cancel_comments') return;
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
  await page.goto('http://127.0.0.1:4178', { waitUntil: 'load' });
  const calls = async kind => page.evaluate(name => window.__fixture.calls.filter(call=>call.command==='browse'&&call.args.kind===name),kind);
  const waitCount = async (kind,count) => page.waitForFunction(({kind,count})=>window.__fixture.calls.filter(call=>call.command==='browse'&&call.args.kind===kind).length===count,{kind,count});
  await page.getByRole('button',{name:'Open Evening listening',exact:true}).waitFor();
  await page.waitForTimeout(180);
  check('Home initially requests one page', (await calls('home')).length===1&&await page.locator('.video-card').count()===25);
  await page.locator('.scroll-loader').scrollIntoViewIfNeeded();await waitCount('home',2);await page.waitForFunction(()=>document.querySelectorAll('.video-card').length===48);
  await page.waitForTimeout(180);
  check('Home scroll fetches exactly one continuation', (await calls('home')).length===2);
  await page.locator('.scroll-loader').scrollIntoViewIfNeeded();await waitCount('home',3);await page.waitForFunction(()=>document.querySelectorAll('.video-card').length===72);
  check('Home successive bottom scroll loads the next page', (await calls('home')).length===3&&await page.locator('.scroll-loader').count()===0);
  await page.getByRole('button',{name:'Playlists',exact:true}).click();await page.getByRole('button',{name:'Open Evening listening',exact:true}).click();
  await page.getByRole('heading',{name:'Evening listening',exact:true}).waitFor();await page.waitForTimeout(160);
  check('Playlist initially displays only 24 items',await page.locator('.playlist-row').count()===24&&(await calls('playlist')).length===1);
  await page.locator('.playlist-videos .scroll-loader').scrollIntoViewIfNeeded();await waitCount('playlist',2);await page.waitForFunction(()=>document.querySelectorAll('.playlist-row').length===48);await page.waitForTimeout(160);
  check('Playlist scroll loads only next page',await page.locator('.playlist-row').count()===48&&(await calls('playlist')).length===2);
  await page.getByRole('button',{name:'Play Fixture video 03 from this playlist',exact:true}).click();await page.getByRole('region',{name:'Comments',exact:true}).waitFor();await page.waitForTimeout(180);
  check('Playing a playlist does not drain remaining pages',await page.locator('.queue-item').count()===48&&(await calls('playlist')).length===2);
  await page.locator('.queue-list').evaluate(el=>{el.scrollTop=el.scrollHeight;});await waitCount('playlist',3);await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===72);await page.waitForTimeout(180);
  check('Queue bottom scroll requests one page and stops',await page.locator('.queue-item').count()===72&&(await calls('playlist')).length===3);
  check('Repeated video IDs remain distinct playlist occurrences',await page.locator('.queue-item strong').allTextContents().then(names=>names.includes('Fixture video 03')&&names.includes('Fixture video 28')));
  await page.evaluate(()=>{window.__fixture.failNextPlaylist=true;});await page.locator('.queue-list').evaluate(el=>{el.scrollTop=el.scrollHeight;});await waitCount('playlist',4);await page.getByText('Fixture network interruption',{exact:true}).waitFor();await page.waitForTimeout(200);
  check('Continuation error does not retry in a loop',(await calls('playlist')).length===4);
  await page.getByRole('button',{name:'Retry playlist loading',exact:true}).click();await waitCount('playlist',5);await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===96);
  check('Explicit retry loads one page preserving queue selection',await page.locator('.queue-item.current strong').textContent()==='Fixture video 03'&&await page.locator('.queue-item').count()===96);
  await page.getByRole('button',{name:/Fixture video 96 Fixture Music/}).click();await waitCount('playlist',6);await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===120);await page.waitForTimeout(160);
  check('Playback near loaded end obtains only the needed next page',await page.locator('.queue-item.current strong').textContent()==='Fixture video 96'&&(await calls('playlist')).length===6);
  await page.getByRole('button',{name:/Fixture video 120 Fixture Music/}).click();const countBefore=(await calls('playlist')).length;check('Last playlist item disables Next',await page.locator('.accessible-controls [aria-label="Next video"]').isDisabled());
  check('Exhausted playlist stops requesting pages',(await calls('playlist')).length===countBefore&&await page.locator('.queue-list .scroll-loader').count()===0);
  await page.getByRole('button',{name:'Go back',exact:true}).click();await page.getByRole('heading',{name:'Evening listening',exact:true}).waitFor();
  check('Queue loading shares cached playlist pages without duplication',await page.locator('.playlist-row').count()===120&&(await calls('playlist')).length===6);
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
  check('Home loaded pages survive navigation without reload',await page.locator('.video-card').count()===72&&(await calls('home')).length===3);
  await page.screenshot({path:path.join(output,'v014-scrolling-home.png')});
  check('No browser errors',errors.length===0,errors);
} catch(error) {
  await browser.contexts()[0]?.pages()[0]?.screenshot({path:path.join(output,'v014-scroll-failure.png')});
  results.push({name:'Scroll checks completed',passed:false,detail:String(error)});process.exitCode=1;
} finally {
  const summary={passed:results.every(result=>result.passed),checks:results};await writeFile(path.join(output,'v014-scroll-results.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));
}
