// Launch the shipped portable layout and verify bundled assets and tool paths.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile,stat} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const executable=join(root,'artifacts/TubeDesk-portable/TubeDesk.exe');
const child=spawn(executable,[],{cwd:dirname(executable),env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9333'},stdio:['ignore','pipe','pipe']});
let diagnostics='';child.stderr.on('data',b=>diagnostics+=b);child.stdout.on('data',()=>{});let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
  let available=false;
  for(let i=0;i<100;i++) {
    if(child.exitCode!==null)throw new Error(`Packaged app exited: ${diagnostics}`);
    try{available=(await fetch('http://127.0.0.1:9333/json/version',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
    if(available)break;await delay(300);
  }
  assert(available,'Packaged WebView did not start');
  browser=await chromium.connectOverCDP('http://127.0.0.1:9333');
  let page;
  for(let i=0;i<50;i++) {page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost')||p.url().startsWith('tauri:'));if(page)break;await delay(150);}
  assert(page,`Expected bundled Tauri origin, without a development server; observed ${JSON.stringify(browser.contexts().flatMap(c=>c.pages()).map(p=>p.url()))}`);
  await page.waitForSelector('#search');
  const duplicate=spawn(executable,[],{cwd:dirname(executable),env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9333'},stdio:'ignore'});
  for(let i=0;i<40&&duplicate.exitCode===null;i++)await delay(100);
  assert.equal(duplicate.exitCode,0,'Duplicate launch should focus the existing app and exit');
  console.log('PASS duplicate launch focuses existing app and exits.');
  const response=await page.evaluate(async()=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke('bootstrap')};}catch(error){return {ok:false,error};}});
  assert(response.ok,JSON.stringify(response.error));
  assert(response.value.tools.every(t=>t.available),'Portable layout missing media helpers');
  assert(await page.evaluate(()=>document.fonts.check('14px Roboto')),'Bundled font unavailable');
  assert((await stat(join(dirname(executable),'player/tubedesk_osc.lua'))).size>0,'Portable native controls resource missing');
  const ipc=(command,args={})=>page.evaluate(async({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  assert((await page.locator('body').innerText()).includes('0.1.2'),'Packaged UI version must be 0.1.2');
  const cache=await ipc('cache_summary');
  assert.equal(typeof cache.enabled,'boolean');assert(cache.maxBytes>0);
  const comments=await ipc('video_comments',{videoId:'fzQ6gRAEoy0',cursor:null,sort:'top',requestId:'package-comments'});
  assert(comments.items.length>0,'Packaged read-only comments returned no items');
  console.log('PASS packaged 0.1.2 cache controls and real read-only comments.');
  const saved=response.value.settings;
  await ipc('save_settings',{settings:{...saved,muted:true,volume:0}});
  try {
    const item={id:'fzQ6gRAEoy0',kind:'video',title:'Shelter',channel:'Porter Robinson',url:'https://www.youtube.com/watch?v=fzQ6gRAEoy0',duration:366,thumbnail:null,viewCount:null,description:null};
    await ipc('play_video',{item,quality:1080,startSeconds:0,playbackMode:'video'});
    let played=false;
    for(let i=0;i<240;i++){const state=await ipc('player_state');if(state.status==='failed')throw Error(state.error);if(state.status==='playing'&&state.position>0.5){played=true;break;}await delay(300);}
    assert(played,'Packaged playback did not start');
    await ipc('player_action',{action:'stop'});
    console.log('PASS packaged native playback and bundled controls resource.');
  } finally { await ipc('save_settings',{settings:saved}); }
  await page.screenshot({path:join(root,'artifacts/packaged-app.png')});
  const result={passed:true,bundledOrigin:page.url(),tools:response.value.tools.map(t=>({name:t.name,available:t.available,version:t.version}))};
  await writeFile(join(root,'artifacts/package-smoke-results.json'),JSON.stringify(result,null,2));
  console.log('PASS packaged app launches, renders bundled UI/font and locates all media helpers.');
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}));
  for(let i=0;i<130&&child.exitCode===null;i++)await delay(100);
  assert.equal(child.exitCode,0,'Packaged app should close cleanly');
} finally {
  if(browser)await browser.close().catch(()=>{});
  if(child.exitCode===null)child.kill();
}
