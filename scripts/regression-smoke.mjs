// TubeDesk 0.1.1 native regression checks. Test data is isolated from remembered accounts.
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=join(root,'artifacts');
await mkdir(out,{recursive:true});
const stamp=Date.now(), data=join(root,`.tools/regression-data-${stamp}`), profile=join(root,`.tools/regression-webview-${stamp}`);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const results=[],children=[];let browser,app,page;
const pass=(name,details={})=>{console.log(`PASS ${name}`);results.push({name,passed:true,...details});};
async function until(fn,label,timeout=90000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){if(e.fatal)throw e;last=e;}await delay(300);}throw Error(`${label}: ${last?.message??'timed out'}`);}
async function invoke(command,args={}){const r=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(e){return {ok:false,error:e};}},{command,args});if(!r.ok)throw Object.assign(Error(r.error?.message??String(r.error)),r.error);return r.value;}
async function launch(){app=spawn(join(root,'src-tauri/target/debug/tubedesk.exe'),[],{cwd:root,windowsHide:false,env:{...process.env,TUBEDESK_DATA_DIR:data,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'},stdio:'ignore'});children.push(app);await until(async()=>{if(app.exitCode!==null)throw Error('App exited');return (await fetch('http://127.0.0.1:9223/json/version',{signal:AbortSignal.timeout(1000)})).ok;},'debug endpoint',30000);browser=await chromium.connectOverCDP('http://127.0.0.1:9223');page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420')),'app page',10000);await page.waitForSelector('#search');}
async function processRows(){const result=await promisify(execFile)('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],{windowsHide:true});return JSON.parse(result.stdout);}
async function ownedIds(){const rows=await processRows(),ids=new Set([app.pid]);let changed=true;while(changed){changed=false;for(const p of rows)if(ids.has(p.ParentProcessId)&&!ids.has(p.ProcessId)){ids.add(p.ProcessId);changed=true;}}return ids;}
async function closeMain(){const owned=await ownedIds();await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}));await until(()=>app.exitCode!==null,'main close exits process',13000);await browser.close().catch(()=>{});browser=null;await until(async()=>{const current=await processRows();return !current.some(p=>owned.has(p.ProcessId));},'owned native/WebView processes released',12000);}
try{
 const vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});children.push(vite);
 await until(async()=>(await fetch('http://127.0.0.1:1420',{signal:AbortSignal.timeout(1000)})).ok,'Vite',15000);await launch();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const initial=await invoke('bootstrap');assert(initial.tools.every(t=>t.available));
 await invoke('save_settings',{settings:{...initial.settings,theme:'dark',volume:0,muted:true,playbackRate:1}});
 await page.reload();await page.waitForSelector('#search');
 await page.evaluate(()=>{window.__tubeCalls={browse:0,play:0};const orig=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=function(cmd,...args){if(cmd==='browse')window.__tubeCalls.browse++;if(cmd==='play_video')window.__tubeCalls.play++;return orig.call(this,cmd,...args);};});
 await page.locator('#search').fill('https://www.youtube.com/watch?v=fzQ6gRAEoy0');await page.getByRole('button',{name:'Search',exact:true}).click();
 const play=page.getByRole('button',{name:/^Play Porter Robinson.*Shelter/}).first();await play.waitFor({timeout:90000});await page.screenshot({path:join(out,'v011-search-dark.png')});await play.click();
 const playing=await until(async()=>{const s=await invoke('player_state');if(s.status==='failed')throw Object.assign(Error(`${s.errorCode}: ${s.error}`),{fatal:true});return s.status==='playing'&&s.position>0.5?s:null;},'Shelter native playback');
 pass('reported Shelter video actually plays',{quality:playing.quality,mode:playing.playbackMode});
 const samples=[];for(let i=0;i<Math.ceil(Number(process.env.TUBEDESK_CONTINUOUS_SECONDS??60)/2);i++){await delay(2000);const s=await invoke('player_state');samples.push({status:s.status,position:s.position,bufferedSeconds:s.bufferedSeconds});assert(!['failed','resolving','ended'].includes(s.status),JSON.stringify({status:s.status,position:s.position,mode:s.playbackMode,loadId:s.loadId,errorCode:s.errorCode}));}assert(samples.at(-1).position>Number(process.env.TUBEDESK_CONTINUOUS_SECONDS??60)-5);pass('Shelter continuous playback',{seconds:Number(process.env.TUBEDESK_CONTINUOUS_SECONDS??60),samples});
 await invoke('player_action',{action:'pause'});await invoke('player_action',{action:'seek',value:8});await invoke('set_playback_mode',{mode:'audio'});
 const audio=await until(async()=>{const s=await invoke('player_state');return s.playbackMode==='audio'&&s.status==='paused'&&s.position>=7?s:null;},'audio mode retains pause/position');assert.equal(audio.quality,0);pass('true audio-only mode preserves paused position');
 await invoke('player_action',{action:'resume'});await until(async()=>{const s=await invoke('player_state');return s.status==='playing'&&s.position>9;},'audio plays');
 await invoke('set_playback_mode',{mode:'video'});await until(async()=>{const s=await invoke('player_state');return s.playbackMode==='video'&&s.status==='playing'&&s.position>9;},'video returns');pass('audio/video switching retains playback intent');
 const before=await page.evaluate(()=>window.__tubeCalls.play);
 await page.getByRole('button',{name:'Home',exact:true}).first().click();await delay(1000);const nav=await invoke('player_state');assert.equal(nav.loadId,(await invoke('player_state')).loadId);assert(nav.position>9);
 const expand=page.getByRole('button',{name:/expand|open player|return to video/i}).first();if(await expand.count()){await expand.click();await delay(400);assert.equal((await page.evaluate(()=>window.__tubeCalls.play)),before);pass('mini-player expansion does not reload media');}
 await page.screenshot({path:join(out,'v011-watch-dark.png')});
 await invoke('player_action',{action:'pause'});
 if(process.env.TUBEDESK_VISUAL_GATE==='1'){await unlink(join(out,'v011-visual-continue.txt')).catch(()=>{});await writeFile(join(out,'v011-visual-ready.json'),JSON.stringify({pid:app.pid,stage:'native controls and clickpause'}));console.log('VISUAL_READY');await until(async()=>{try{await stat(join(out,'v011-visual-continue.txt'));return true;}catch{return false;}},'visual check',600000);}
 const mix=await invoke('browse',{kind:'playlist',query:'https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDfzQ6gRAEoy0',cursor:null,requestId:'regression-mix'});assert(mix.items.length>0);assert(mix.collection?.isMix);pass('live seeded Mix extraction',{count:mix.items.length});
 const zoo=(await invoke('browse',{kind:'search',query:'https://www.youtube.com/watch?v=jNQXAC9IVRw',cursor:null,requestId:'regression-zoo'})).items[0];
 const task=await invoke('enqueue_download',{request:{item:zoo,mode:'video',quality:240,directory:join(data,'downloads'),format:'mp4'}});await invoke('download_action',{taskId:task.id,action:'pause'});await until(async()=>(await invoke('bootstrap')).downloads.find(x=>x.id===task.id)?.status==='paused','pause download',20000);await invoke('download_action',{taskId:task.id,action:'resume'});
 const done=await until(async()=>{const d=(await invoke('bootstrap')).downloads.find(x=>x.id===task.id);if(d?.status==='failed')throw Error(d.error);return d?.status==='completed'?d:null;},'completed download',120000);
 const probe=JSON.parse((await promisify(execFile)(join(root,'tools/ffprobe.exe'),['-v','error','-show_entries','stream=codec_type','-of','json',done.outputPath],{windowsHide:true})).stdout);assert(probe.streams.some(s=>s.codec_type==='video'));assert(probe.streams.some(s=>s.codec_type==='audio'));pass('download pause/resume/completion and independent output validation',{bytes:(await stat(done.outputPath)).size});
 await invoke('play_local',{taskId:task.id});await until(async()=>{const s=await invoke('player_state');return s.status==='playing'&&s.position>0.1;},'offline local file');pass('completed local file playback');
 await invoke('open_sign_in');pass('isolated sign-in window created');
 await closeMain();pass('closing main also destroys hidden or visible auth and exits');
 await launch();const reopened=await invoke('bootstrap');assert(reopened.downloads.some(x=>x.id===task.id&&x.status==='completed'));await closeMain();pass('restart preserves local library and exits normally');
 assert.equal(errors.length,0,errors.join('\n'));pass('no frontend runtime errors');
 await writeFile(join(out,'v011-regression-results.json'),JSON.stringify({passed:true,results},null,2));
}catch(error){console.error(error);await writeFile(join(out,'v011-regression-results.json'),JSON.stringify({passed:false,results,error:String(error.stack||error)},null,2));process.exitCode=1;}
finally{await browser?.close().catch(()=>{});for(const child of children.reverse())if(child.exitCode===null)child.kill();}
