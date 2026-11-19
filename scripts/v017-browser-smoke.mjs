// Browser-only regression fixtures. Never imported by the application bundle.
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const server = await preview({ root, preview: { host: '127.0.0.1', port: 1423, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const results = [];
const check = (name, passed, detail) => { results.push({ name, passed, detail }); if (!passed) throw new Error(name); };
async function scaledOverlayChecks(browser, output, check) {
  for (const scale of [1,1.25,1.5,2]) for (const theme of ['dark','light']) {
    const context=await browser.newContext({viewport:{width:1000,height:560},deviceScaleFactor:scale,colorScheme:theme,reducedMotion:'reduce'}), page=await context.newPage();
    await page.addInitScript(()=>{
      let callbackId=0;const callbacks=new Map(),listeners=new Map();
      const player={status:'paused',video:{id:'dQw4w9WgXcQ',kind:'video',title:'Scaled shared controls',channel:'Fixture',thumbnail:null,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',duration:360,viewCount:1,description:null},position:30,duration:360,volume:37,muted:false,speed:1,quality:1080,qualities:[1080,720,480],error:null,loadId:1,playbackMode:'video',requestedQuality:1080,bufferedSeconds:30,errorCode:null};
      player.video.heatmap=[{startTime:0,endTime:120,value:0.15},{startTime:120,endTime:240,value:1},{startTime:240,endTime:360,value:0.3}];
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_,id)=>listeners.delete(id)};
      window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'player-overlay'},currentWebview:{label:'player-overlay'}},transformCallback:fn=>{const id=++callbackId;callbacks.set(id,fn);return id;},unregisterCallback:id=>callbacks.delete(id),invoke:async(command,args={})=>{
        if(command==='plugin:event|listen'){const id=++callbackId;listeners.set(id,args);return id;}
        if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
        if(command==='player_overlay_snapshot')return{revision:1,player,ui:{hasPrevious:true,hasNext:true,mini:false,theater:false,fullscreen:false},pausedIntent:true,overlayError:null};
        if(command==='player_overlay_action')return;
        throw Error('Unexpected scaled overlay fixture command '+command);
      }};
    });
    await page.goto('http://127.0.0.1:1423/?player-overlay=1');await page.locator('.player-overlay-root').waitFor();await page.mouse.move(500,250);await page.getByRole('button',{name:'Playback settings',exact:true}).click();
    const graph = page.locator('.seek-heatmap');
    check(`Video replay heatmap fits at DPR ${scale} in ${theme} scheme`, await graph.isVisible() && await graph.evaluate(el => {
      const graph = el.getBoundingClientRect(), slider = el.parentElement.querySelector('input');
      const rail = slider.getBoundingClientRect(), style = getComputedStyle(el);
      const description = document.getElementById(slider.getAttribute('aria-describedby'));
      return graph.left >= rail.left && graph.right <= rail.right && Math.abs(graph.bottom - rail.top) < 0.5
        && style.pointerEvents === 'none' && style.clipPath.startsWith('polygon(')
        && description?.textContent === 'Most replayed around 3:00';
    }));
    const dimensions=await page.locator('.player-settings-menu').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{ratio:devicePixelRatio,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,shadow:s.boxShadow,radius:s.borderRadius,stroke:[...el.querySelectorAll(':scope > button > svg')].map(svg=>getComputedStyle(svg).strokeWidth),rowHeights:[...el.querySelectorAll(':scope > button')].map(b=>b.getBoundingClientRect().height),overflow:document.documentElement.scrollWidth>innerWidth};});
    check(`Shared menu fits at DPR ${scale} in ${theme} scheme`,Math.abs(dimensions.ratio-scale)<.001&&Math.abs(dimensions.width-305)<1&&dimensions.x>=0&&dimensions.y>=0&&dimensions.right<=1000&&dimensions.bottom<=560&&!dimensions.overflow&&dimensions.shadow==='none'&&dimensions.radius==='12px'&&dimensions.stroke.every(x=>x==='2px')&&dimensions.rowHeights.every(h=>h>=44),dimensions);
    await page.screenshot({path:path.join(output,`v017-browser-menu-${theme}-${String(scale).replace('.','_')}.png`)});
    await page.getByRole('menuitem',{name:/Playback speed/}).click();const menu=page.locator('.player-settings-menu');const before=await menu.evaluate(el=>el.scrollTop);await menu.hover();await page.mouse.wheel(0,250);await page.waitForTimeout(80);check(`Speed submenu remains independently scrollable at DPR ${scale} in ${theme}`,await menu.evaluate(el=>getComputedStyle(el).scrollbarWidth!=='none'&&el.scrollHeight>el.clientHeight&&el.scrollTop>0)&&before===0);
    await context.close();
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const art = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#6c7da2"/><stop offset=".6" stop-color="#243957"/><stop offset="1" stop-color="#131b32"/></linearGradient></defs><path fill="url(#g)" d="M0 0h640v360H0z"/><circle fill="#d8c4ad" cx="490" cy="95" r="47"/><path fill="#405777" d="m0 270 130-145 130 115L420 80l220 210v70H0z"/><path fill="#16263f" d="m0 320 170-135 120 115 115-105 235 140v25H0z"/></svg>')}`;
    const video = index => ({ id: index === 3 || index === 28 ? 'duplicate-id' : `fixture-${index}`, kind: 'video', title: `Fixture video ${String(index).padStart(2, '0')}`, channel: 'Fixture Music', thumbnail: art, url: `https://www.youtube.com/watch?v=fixture${index}`, duration: 190 + index, viewCount: 10000 + index * 153, description: null, playlistIndex: index,
      ...(index >= 119 && { heatmap: [{ startTime: 0, endTime: 50, value: 0.1 }, { startTime: 50, endTime: 100, value: 0.9 }, { startTime: 100, endTime: 190 + index, value: 0.35 }] }),
    });
    const playlist = { id: 'PLfixture', kind: 'playlist', title: 'Evening listening', channel: 'Fixture listener', thumbnail: art, url: 'https://www.youtube.com/playlist?list=PLfixture', duration: null, viewCount: null, description: 'A quiet collection for the end of the day.' };
    const collection = { id: 'PLfixture', title: playlist.title, owner: playlist.channel, thumbnail: art, itemCount: 120, description: playlist.description, isMix: false, url: playlist.url };
    const MiB = 1024 ** 2;
    const cacheData = { enabled: true, maxBytes: 2 * 1024 ** 3, totalBytes: 120 * MiB, audioBytes: 16 * MiB, videoBytes: 96 * MiB, pendingBytes: 8 * MiB, entryCount: 3, activeCount: 1, entries: [
      { id: 'cached-audio', videoId: 'audio', title: 'Fixture cached audio', mode: 'audio', quality: 0, bytes: 16 * MiB, lastAccessed: 1780000000, pinned: false },
      { id: 'cached-video', videoId: 'video', title: 'Fixture cached video', mode: 'video', quality: 720, bytes: 64 * MiB, lastAccessed: 1780000000, pinned: false },
      { id: 'playing-cache', videoId: 'playing', title: 'Fixture currently playing', mode: 'video', quality: 1080, bytes: 32 * MiB, lastAccessed: 1780000000, pinned: true },
    ] };
    const restore = new URLSearchParams(location.search).get('restore-session');
    const session = { generation: 1, status: restore === null ? 'connected' : 'restoring', label: restore === null ? 'Fixture listener' : null, message: null };
    const settings = { theme: 'system', downloadDirectory: 'C:\\Fixture downloads', defaultQuality: 1080, volume: 80, muted: false, playbackRate: 1, alwaysAudioOnly: false };
    let player = { status: 'idle', video: null, position: 0, duration: 0, volume: 80, muted: false, speed: 1, quality: 1080, requestedQuality: 1080, qualities: [1080, 720, 480], error: null, errorCode: null, bufferedSeconds: 30, loadId: 0, playbackMode: 'video' };
    let callbackId = 0; const callbacks = new Map(); const listeners = new Map();
    const state = { calls: [], bounds: null, context: null, emit: (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); } };
    state.endVideo = () => { player = {...player,status:'ended',position:player.duration}; state.emit('player-state',player); };
    state.restoreSession = () => {
      Object.assign(session, { status: 'connected', label: 'Fixture listener' });
      state.emit('session-changed', { ...session });
    };
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
        if (command === 'bootstrap') {
          const snapshot = { ...session };
          if (restore === 'during-bootstrap') await new Promise(resolve => { state.finishBootstrap = resolve; });
          return { session: snapshot, settings, downloads: [], history: [{ video: video(1), duration: video(1).duration, position: 52, updatedAt: Math.floor(Date.now() / 1000) }], tools: [] };
        }
        if (command === 'session_state') return session;
        if (command === 'browse') {
          const status = session.status;
          await new Promise(resolve => setTimeout(resolve, 35));
          if (args.kind === 'home' && status === 'restoring') return { items: [{ ...video(1), title: 'Public Home video' }], nextCursor: null };
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
        if (command === 'player_overlay_snapshot') return {revision:1,player,ui:{hasPrevious:false,hasNext:true,mini:false,theater:false,fullscreen:false},pausedIntent:player.status==='paused',overlayError:null};
        if (command === 'player_state') return player;
        if (command === 'play_video') { player = { ...player, video: args.item, status: 'playing', loadId: player.loadId + 1, position: 0, duration: args.item.duration, playbackMode: args.playbackMode ?? player.playbackMode }; state.emit('player-state', player); return; }
        if (command === 'player_overlay_action') { if(args.action==='adjust-volume') player={...player,volume:Math.max(0,Math.min(100,player.volume+args.value))}; state.emit('player-state',player); return; }
        if (command === 'player_action') { if (args.action === 'toggle') player = { ...player, status: player.status === 'playing' ? 'paused' : 'playing' }; else if (args.action === 'speed') player = { ...player, speed: args.value }; else if (args.action === 'stop') player = { ...player, status: 'idle', video: null }; state.emit('player-state', player); return; }
        if (command === 'set_playback_mode') { player = { ...player, playbackMode: args.mode }; state.emit('player-state', player); return; }
        if (command === 'player_ui_context') { state.context = args.context; return; }
        if (command === 'player_bounds') { state.bounds = args.bounds; return; }
        if (command === 'save_settings') { Object.assign(settings, args.settings); return settings; }
        if (command === 'retry_player_overlay') return;
        if (command === 'clear_history' || command === 'cancel_browse' || command.startsWith('plugin:window|')) return;
        throw new Error(`Unimplemented fixture command: ${command}`);
      },
    };
  });
  const calls = async kind => page.evaluate(name => window.__fixture.calls.filter(call=>call.command==='browse'&&call.args.kind===name),kind);
  const waitCount = async (kind,count) => page.waitForFunction(({kind,count})=>window.__fixture.calls.filter(call=>call.command==='browse'&&call.args.kind===kind).length===count,{kind,count});
  await page.goto('http://127.0.0.1:1423/?restore-session');
  const publicVideo = page.getByRole('button', { name: 'Play Public Home video', exact: true });
  await publicVideo.waitFor();
  check('Saved session shows checking status while public Home loads', await page.getByRole('status').filter({ hasText: 'Checking YouTube sign-in' }).isVisible() && await page.getByRole('button', { name: /^(Sign in|Account sign-in)$/ }).count() === 0);
  await page.evaluate(() => window.__fixture.restoreSession());
  await page.getByRole('button', { name: 'Connected account' }).waitFor();
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).waitFor();
  await page.evaluate(() => window.__fixture.restoreSession());
  await page.waitForTimeout(100);
  check('Same-generation sign-in refreshes Home once with a personalized feed', await publicVideo.count() === 0 && (await calls('home')).length === 2);

  await page.goto('http://127.0.0.1:1423/?restore-session=during-bootstrap');
  await page.waitForFunction(() => typeof window.__fixture.finishBootstrap === 'function');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    window.__fixture.restoreSession();
    window.__fixture.finishBootstrap();
  });
  await page.getByRole('button', { name: 'Manage sign-in', exact: true }).waitFor();
  await waitCount('home', 1);
  check('Sign-in during bootstrap refreshes Home without leaving Settings', await page.getByRole('heading', { name: 'Settings', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).waitFor();
  check('Home reuses the updated feed when the user returns', (await calls('home')).length === 1);

  await page.goto('http://127.0.0.1:1423', { waitUntil: 'load' });
  await page.getByRole('button',{name:'Open Evening listening',exact:true}).waitFor();
  await page.waitForTimeout(180);
  check('Outer document scrollbar is hidden without disabling overflow', await page.locator('html').evaluate(el=>getComputedStyle(el).scrollbarWidth==='none'&&getComputedStyle(el).overflowY!=='hidden'));
  check('Home initially requests one page', (await calls('home')).length===1&&await page.locator('.video-card').count()===25);
  await page.locator('.scroll-loader').scrollIntoViewIfNeeded();await waitCount('home',2);await page.waitForFunction(()=>document.querySelectorAll('.video-card').length===48);
  await page.waitForTimeout(180);
  check('Home scroll fetches exactly one continuation', (await calls('home')).length===2);
  await page.locator('.scroll-loader').scrollIntoViewIfNeeded();await waitCount('home',3);await page.waitForFunction(()=>document.querySelectorAll('.video-card').length===72);
  check('Home successive bottom scroll loads the next page', (await calls('home')).length===3&&await page.locator('.scroll-loader').count()===0);
  check('Header Home shortcut is removed while sidebar Home remains',await page.locator('.header-home').count()===0&&await page.getByRole('button',{name:'Home',exact:true}).count()===1);
  const circle=await page.locator('.search-submit').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {w:r.width,h:r.height,radius:s.borderRadius};});
  check('Search submit is a separate 46px circular accessible button',circle.w===46&&circle.h===46&&circle.radius==='50%');
  await page.getByRole('button',{name:'Back to top',exact:true}).waitFor();await page.getByRole('button',{name:'Back to top',exact:true}).click();await page.waitForFunction(()=>scrollY<2);
  check('Home back-to-top returns to the heading without reloading pages',await page.locator('.video-card').count()===72&&(await calls('home')).length===3&&await page.getByRole('heading',{name:'Home',exact:true}).evaluate(el=>document.activeElement===el));
  await page.getByRole('button',{name:'Playlists',exact:true}).click();await page.getByRole('button',{name:'Open Evening listening',exact:true}).click();
  await page.getByRole('heading',{name:'Evening listening',exact:true}).waitFor();await page.waitForTimeout(160);
  check('Playlist initially displays only 24 items',await page.locator('.playlist-row').count()===24&&(await calls('playlist')).length===1);
  await page.locator('.playlist-videos .scroll-loader').scrollIntoViewIfNeeded();await waitCount('playlist',2);await page.waitForFunction(()=>document.querySelectorAll('.playlist-row').length===48);await page.waitForTimeout(160);
  check('Playlist scroll loads only next page',await page.locator('.playlist-row').count()===48&&(await calls('playlist')).length===2);
  await page.getByRole('button',{name:'Back to top',exact:true}).waitFor();await page.getByRole('button',{name:'Back to top',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>scrollY<2);
  check('Playlist back-to-top works by keyboard and retains loaded videos',await page.locator('.playlist-row').count()===48&&(await calls('playlist')).length===2);
  await page.getByRole('button',{name:'Play Fixture video 03 from this playlist',exact:true}).click();await page.getByRole('region',{name:'Comments',exact:true}).waitFor();await page.waitForTimeout(180);
  check('Playing a playlist does not drain remaining pages',await page.locator('.queue-item').count()===48&&(await calls('playlist')).length===2);
  const queueScroll=page.locator('.queue-list');const rootBeforeQueueWheel=await page.evaluate(()=>scrollY);await queueScroll.hover();await page.mouse.wheel(0,180);await page.waitForTimeout(120);check('Internal queue keeps its independent visible scrollbar and wheel scrolling',await queueScroll.evaluate(el=>getComputedStyle(el).scrollbarWidth==='thin'&&el.scrollTop>0)&&await page.evaluate(()=>scrollY)===rootBeforeQueueWheel);
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
  check('Watch page omits the keyboard controls button', await page.getByRole('button', { name: 'Keyboard controls', exact: true }).count() === 0);
  await page.locator('.watch-topline .back-button').focus();
  await page.keyboard.press('Tab');
  check('Tab reveals the accessible playback controls', await page.locator('.accessible-controls:focus-within').count() === 1);
  await page.keyboard.press('Shift+Tab');
  check('Accessible playback controls collapse when focus leaves', await page.locator('.accessible-controls').evaluate(element => element.getBoundingClientRect().height === 1));
  check('Exhausted playlist stops requesting pages',(await calls('playlist')).length===countBefore&&await page.locator('.queue-list .scroll-loader').count()===0);
  await page.locator('.queue-list').getByRole('button',{name:/Fixture video 119 Fixture Music/}).click();
  await page.getByRole('button',{name:'Listen with audio only',exact:true}).click();
  await page.evaluate(()=>window.__fixture.endVideo());
  await page.waitForFunction(()=>document.querySelector('.queue-item.current strong')?.textContent==='Fixture video 120');
  const startsAtQueueEnd = await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='play_video').length);
  await page.evaluate(()=>window.__fixture.endVideo());
  await page.locator('.full-player .player-surface').hover();
  await page.getByRole('button',{name:'Play (Space)',exact:true}).waitFor();
  check('Final audio item stops with replay available and no error',await page.locator('.player-error').count()===0&&await page.getByRole('button',{name:'Next video',exact:true}).isDisabled()&&await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='play_video').length)===startsAtQueueEnd);
  const audioSeek = page.getByRole('slider',{name:'Playback position'});
  check('Audio progress shows the replay distribution and its accessible peak',await page.locator('.full-player .seek-heatmap').isVisible()&&await audioSeek.evaluate(el=>document.getElementById(el.getAttribute('aria-describedby'))?.textContent==='Most replayed around 1:15'));
  await audioSeek.press('ArrowLeft');
  check('Keyboard seeking still works with replay data',await page.evaluate(()=>window.__fixture.calls.some(call=>call.command==='player_action'&&call.args.action==='seek'&&call.args.value===309.9)));
  await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('heading',{name:'Evening listening',exact:true}).waitFor();
  check('Queue loading shares cached playlist pages without duplication',await page.locator('.playlist-row').count()===120&&(await calls('playlist')).length===6);
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
  check('Home loaded pages survive navigation without reload',await page.locator('.video-card').count()===72&&(await calls('home')).length===3);
  await page.locator('.mini-player .player-surface').hover();
  check('Floating audio player keeps its footer Expand player control',await page.getByRole('button',{name:'Expand player',exact:true}).isVisible()&&await page.locator('.mini-player .player-surface button[aria-label*="fullscreen" i]').count()===0);
  const miniGraph = page.locator('.mini-player .seek-heatmap');
  await miniGraph.waitFor({state:'visible'});
  check('Floating audio player shows a compact replay heatmap',await miniGraph.evaluate(el=>el.getBoundingClientRect().height===19));
  await page.getByRole('button',{name:'Move player to bottom bar',exact:true}).click();
  const dockedGraph = page.locator('.bottom-player-progress .seek-heatmap');
  await dockedGraph.waitFor({state:'visible'});
  check('Docked player aligns the replay heatmap to its own progress bar',await dockedGraph.evaluate(el=>Math.abs(el.getBoundingClientRect().bottom-el.parentElement.querySelector('input').getBoundingClientRect().top)<0.5));
  await page.getByRole('button',{name:'Restore floating mini player',exact:true}).click();
  await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await page.mouse.move(950,500);await page.mouse.wheel(0,600);await page.waitForTimeout(120);check('Root wheel scrolling works with no visible page scrollbar',await page.evaluate(()=>scrollY)>0);const yBeforePageUp=await page.evaluate(()=>scrollY);await page.keyboard.press('PageUp');await page.waitForTimeout(200);check('Root PageUp retains document scrolling',await page.evaluate(()=>scrollY)<yBeforePageUp);await page.keyboard.press('End');await page.waitForTimeout(200);check('Root End key reaches loaded page bottom',await page.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-2));await page.keyboard.press('Home');await page.waitForTimeout(200);check('Root Home key returns to top',await page.evaluate(()=>scrollY)<2);
  await page.evaluate(()=>scrollTo(0,600));await page.getByRole('button',{name:'Back to top',exact:true}).waitFor();
  const topBox=await page.locator('.back-to-top').boundingBox(),miniBox=await page.locator('.mini-player').boundingBox();
  check('Back-to-top remains separated from the floating mini player',topBox&&miniBox&&topBox.x+topBox.width+12<=miniBox.x);
  await page.evaluate(()=>scrollTo(0,300));await page.waitForTimeout(80);const savedY=await page.evaluate(()=>scrollY);await page.getByRole('button',{name:'Downloads',exact:true}).click();await page.getByRole('button',{name:'Home',exact:true}).click();await page.waitForTimeout(180);check('Saved Home scroll position survives navigation with hidden scrollbar',Math.abs((await page.evaluate(()=>scrollY))-savedY)<2);
  await page.locator('.sidebar-bottom').getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('light');await page.waitForTimeout(50);check('Light theme retains hidden outer scrollbar',await page.locator('html').evaluate(el=>el.dataset.theme==='light'&&getComputedStyle(el).scrollbarWidth==='none'));await page.screenshot({path:path.join(output,'v017-browser-light-settings.png')});await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('dark');await page.getByRole('button',{name:'Home',exact:true}).click();
  await page.screenshot({path:path.join(output,'v017-browser-scrolling-home.png')});
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByRole('button',{name:'Play Fixture video 01',exact:true}).click();
  const historyPlay = await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='play_video').at(-1).args);
  check('History opens a fresh item even with a legacy saved position',historyPlay.item.id==='fixture-1'&&!('startSeconds' in historyPlay));
  await page.locator('.full-player .seek-slider').waitFor({state:'attached'});
  check('A video without replay data keeps the plain seek bar',await page.locator('.full-player .seek-slider').count()===1&&await page.locator('.full-player .seek-heatmap').count()===0);
  await scaledOverlayChecks(browser,output,check);
  check('No browser errors',errors.length===0,errors);
} catch(error) {
  await browser.contexts()[0]?.pages()[0]?.screenshot({path:path.join(output,'v017-browser-failure.png')});
  results.push({name:'Scroll checks completed',passed:false,detail:String(error)});process.exitCode=1;
} finally {
  const summary={passed:results.every(result=>result.passed),checks:results};await writeFile(path.join(output,'v017-browser-results.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({passed:summary.passed,checks:results.length,failures:results.filter(r=>!r.passed)}));await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));
}
