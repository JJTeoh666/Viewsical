// Real native integration test. Launches its own Vite/app children in one session.
// No credentials or external-browser sessions are read. Debug CDP is test-only.
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'artifacts');await mkdir(out,{recursive:true});
const run=String(Date.now());
const results=[];const children=[];let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=90000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end) { try { const value=await fn();if(value)return value; }catch(e){last=e;} await delay(350); }
  throw new Error(`Timed out: ${label}${last?` (${last.message})`:''}`);
}
function pass(name,details={}) {results.push({name,passed:true,...details});console.log(`PASS ${name}`);}
try {
  const vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(vite);
  let viteLog='';vite.stderr.on('data',b=>viteLog+=b);vite.stdout.on('data',()=>{});
  await until(async()=>{if(vite.exitCode!==null)throw new Error(viteLog);return (await fetch('http://127.0.0.1:1420',{signal:AbortSignal.timeout(1500)})).ok;},'Vite',20000);
  const app=spawn(join(root,'src-tauri/target/debug/tubedesk.exe'),[],{cwd:root,windowsHide:false,env:{...process.env,TUBEDESK_DATA_DIR:join(root,`.tools/native-test-data-${run}`),WEBVIEW2_USER_DATA_FOLDER:join(root,`.tools/native-test-webview-${run}`),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9222'},stdio:['ignore','pipe','pipe']});children.push(app);
  let appLog='';app.stdout.on('data',b=>appLog+=b);app.stderr.on('data',b=>appLog+=b);
  await until(async()=>{if(app.exitCode!==null)throw new Error(appLog);return (await fetch('http://127.0.0.1:9222/json/version',{signal:AbortSignal.timeout(1500)})).ok;},'WebView2 debugging endpoint',30000);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420')),'local app page',10000);
  await page.waitForSelector('#search');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoke=async(command,args={})=>{
    const result=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error};}},{command,args});
    if(!result.ok)throw Object.assign(new Error(result.error?.message||String(result.error)),result.error);
    return result.value;
  };
  const initial=await invoke('bootstrap');assert(initial.tools.every(t=>t.available));pass('all five bundled media tools available');
  const cancelled=invoke('browse',{kind:'search',query:'Rust compiler',cursor:null,requestId:'smoke-cancel'}).then(()=>({ok:true}),error=>({ok:false,code:error?.code,error:typeof error==='string'?error:error?.message}));
  await delay(100);await invoke('cancel_browse',{requestId:'smoke-cancel'});const cancelledResult=await cancelled;assert.equal(cancelledResult.code,'cancelled',JSON.stringify(cancelledResult));pass('in-flight search cancellation');
  await invoke('save_settings',{settings:{...initial.settings,theme:'light',volume:0,muted:true,playbackRate:1.25}});
  await page.reload();await page.waitForSelector('#search');
  await page.getByRole('textbox',{name:'Search YouTube or paste a video link'}).fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  const playButton=page.getByRole('button',{name:'Play Me at the zoo',exact:true});await playButton.waitFor({timeout:90000});
  pass('live YouTube link search renders actual metadata');
  await page.screenshot({path:join(out,'app-search-light.png')});
  await playButton.click();
  const playing=await until(async()=>{const p=await invoke('player_state');if(p.status==='failed')throw new Error(p.error);return p.status==='playing'&&p.duration>0&&p.position>0.3?p:null;},'native video playback',90000);
  assert.equal(playing.speed,1.25);assert.equal(playing.volume,0);assert.equal(playing.muted,true);pass('new playback applies saved control preferences');
  await invoke('player_action',{action:'mute',value:1});await invoke('player_action',{action:'pause'});
  await invoke('player_action',{action:'seek',value:5});
  const paused=await until(async()=>{const p=await invoke('player_state');return p.status==='paused'&&p.position>=4?p:null;},'pause and seek');
  pass('actual native playback, pause and seek',{duration:playing.duration,position:paused.position,qualities:paused.qualities});
  await page.screenshot({path:join(out,'app-watch-light.png')});
  if(process.env.TUBEDESK_VISUAL_GATE==='1') {
    const signal=join(out,'visual-continue.txt');await unlink(signal).catch(()=>{});
    await writeFile(join(out,'visual-ready.json'),JSON.stringify({stage:'paused native video',pid:app.pid}));
    console.log('VISUAL_READY paused native video; waiting for artifacts/visual-continue.txt');
    await until(async()=>{try{await stat(signal);return true;}catch{return false;}},'native screenshot inspection',240000);
  }
  if(paused.qualities.length>1) {
    const lower=paused.qualities.find(q=>q!==paused.quality);
    await invoke('player_action',{action:'quality',value:lower});
    const changed=await until(async()=>{const p=await invoke('player_state');return p.status==='paused'&&p.quality===lower&&p.position>=4?p:null;},'quality switch retaining pause and position');
    pass('quality switching preserves pause and position',{quality:changed.quality,position:changed.position});
  }
  await page.getByRole('button',{name:'Fullscreen (F)',exact:true}).click();await delay(600);
  assert(await page.evaluate(()=>innerWidth>1000));await page.getByRole('button',{name:'Exit fullscreen (F)',exact:true}).click();pass('fullscreen enters and exits');
  const item=playing.video;
  const task=await invoke('enqueue_download',{request:{item,mode:'video',quality:240,directory:join(root,`.tools/native-downloads-${run}`),format:'mp4'}});
  await invoke('download_action',{taskId:task.id,action:'pause'});
  await until(async()=>{const b=await invoke('bootstrap');return b.downloads.find(t=>t.id===task.id)?.status==='paused';},'download pause',20000);
  await invoke('download_action',{taskId:task.id,action:'resume'});
  const finished=await until(async()=>{const b=await invoke('bootstrap');const d=b.downloads.find(t=>t.id===task.id);if(d?.status==='failed')throw new Error(d.error);return d?.status==='completed'?d:null;},'real completed download',120000);
  assert(finished.outputPath);assert((await stat(finished.outputPath)).size>0);
  const {stdout}=await promisify(execFile)(join(root,'tools/ffprobe.exe'),['-v','error','-show_entries','stream=codec_type','-show_entries','format=duration','-of','json',finished.outputPath],{windowsHide:true});
  const probe=JSON.parse(stdout);assert(probe.streams.some(s=>s.codec_type==='video'));assert(probe.streams.some(s=>s.codec_type==='audio'));
  pass('real download pauses, resumes, merges and validates',{bytes:(await stat(finished.outputPath)).size,duration:Number(probe.format.duration)});
  const audioTask=await invoke('enqueue_download',{request:{item,mode:'audio',quality:240,directory:join(root,`.tools/native-downloads-${run}`),format:'original'}});
  const audioResult=()=>until(async()=>{const b=await invoke('bootstrap');const d=b.downloads.find(t=>t.id===audioTask.id);return d&&['completed','failed'].includes(d.status)?d:null;},'audio-only download',90000);
  let audio=await audioResult();let transportRetry=false;
  if(audio.status==='failed'&&audio.error?.includes('connection failed')) {
    console.log('Audio transport failed; exercising explicit Resume once.');transportRetry=true;
    await delay(1500);await invoke('download_action',{taskId:audioTask.id,action:'resume'});audio=await audioResult();
  }
  assert.equal(audio.status,'completed',audio.error||'Audio download did not complete');
  const audioProbe=JSON.parse((await promisify(execFile)(join(root,'tools/ffprobe.exe'),['-v','error','-show_entries','stream=codec_type','-of','json',audio.outputPath],{windowsHide:true})).stdout);
  assert(audioProbe.streams.some(s=>s.codec_type==='audio'));assert(!audioProbe.streams.some(s=>s.codec_type==='video'));pass('audio-only download preserves source audio container',{resumedAfterTransportFailure:transportRetry});
  await invoke('play_local',{taskId:task.id});await until(async()=>{const p=await invoke('player_state');return p.status==='playing'&&p.position>0.2;},'downloaded local file playback');pass('completed local file plays without stream resolution');
  await invoke('player_action',{action:'pause'});
  await assert.rejects(invoke('browse',{kind:'subscriptions',query:'',cursor:null,requestId:'smoke-account-required'}));pass('account library rejects anonymous session');
  await assert.rejects(invoke('browse',{kind:'search',query:'https://attacker.invalid/test',cursor:null,requestId:'smoke-invalid-url'}));pass('untrusted pasted URLs rejected');
  await invoke('open_sign_in');
  const remote=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/accounts\.google\.com|youtube\.com/.test(p.url())),'isolated sign-in window',20000);
  await remote.waitForLoadState('domcontentloaded',{timeout:20000}).catch(()=>{});
  const denied=await remote.evaluate(async()=>{try{await window.__TAURI_INTERNALS__.invoke('bootstrap');return false;}catch{return true;}});assert(denied);pass('remote sign-in page cannot call privileged app commands');
  // Observe availability only. No Google credentials or auth controls are automated.
  pass('dedicated sign-in window opens',{host:new URL(remote.url()).host});
  await invoke('sign_out');
  await page.getByRole('button',{name:'Settings',exact:true}).first().click();await page.getByLabel('Theme').selectOption('dark').catch(async()=>{await invoke('save_settings',{settings:{...(await invoke('bootstrap')).settings,theme:'dark'}});await page.reload();});
  await delay(400);await page.screenshot({path:join(out,'app-settings-dark.png')});
  assert.equal(errors.length,0,errors.join('\n'));pass('no frontend runtime errors');
  await writeFile(join(out,'native-smoke-results.json'),JSON.stringify({passed:true,results},null,2));
} catch(error) {
  await writeFile(join(out,'native-smoke-results.json'),JSON.stringify({passed:false,results,error:String(error?.stack||error)},null,2));
  console.error(error);process.exitCode=1;
} finally {
  if(browser)await browser.close().catch(()=>{});
  for(const child of children.reverse())if(child.exitCode===null)child.kill();
}
