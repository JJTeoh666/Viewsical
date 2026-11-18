// Native window/renderer integration with isolated data and real local media.
import {chromium} from 'playwright';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,link,copyFile,readFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';import assert from 'node:assert/strict';
import {verify} from './v016-native-actions.mjs';
const root=resolve(import.meta.dirname,'..'),stamp=Date.now(),data=process.env.VIEWSICAL_TEST_DATA_DIR||join(root,`.tools/v016-data-${stamp}`),profile=join(root,`.tools/v016-webview-${stamp}`),port=9341;
const delay=ms=>new Promise(r=>setTimeout(r,ms)),shell=promisify(execFile),children=[],results=[];let app,browser,page,overlay,pipe;
const pass=(name,details={})=>{results.push({name,passed:true,...details});console.log('PASS '+name);};
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){if(e.fatal)throw e;last=e;}await delay(150);}throw Error(label+' timed out'+(last?': '+last.message:''));}
async function invoke(target,command,args={}){const r=await target.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error};}},{command,args});if(!r.ok)throw Object.assign(Error(r.error?.message??String(r.error)),r.error);return r.value;}
const ipc=(command,args={})=>invoke(page,command,args);
async function webviewMemory(){
 const {stdout}=await shell('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress'],{windowsHide:true});
 const all=JSON.parse(stdout),ids=new Set([app.pid]);let added=true;
 while(added){added=false;for(const p of all)if(ids.has(p.ParentProcessId)&&!ids.has(p.ProcessId)){ids.add(p.ProcessId);added=true;}}
 const processes=all.filter(p=>ids.has(p.ProcessId)&&p.Name==='msedgewebview2.exe');
 return {bytes:processes.reduce((s,p)=>s+Number(p.WorkingSetSize),0),processes:processes.length,ownedPids:[...ids]};
}
async function playing(){return until(async()=>{const s=await ipc('player_state');if(s.status==='failed')throw Object.assign(Error(s.errorCode+': '+s.error),{fatal:true});return s.status==='playing'&&s.position>.3?s:null;},'native playing');}
async function native(){const r=await shell('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${app.pid} -and $_.Name -eq 'mpv.exe' } | Select-Object -ExpandProperty CommandLine`],{windowsHide:true});const m=r.stdout.match(/--input-ipc-server=(?:"([^"]+)"|([^\s]+))/);assert(m,'owned mpv pipe');pipe=net.createConnection(m[1]??m[2]);await new Promise((r,j)=>{pipe.once('connect',r);pipe.once('error',j);});let b='',id=0;const pending=new Map();pipe.on('data',v=>{b+=v;while(b.includes('\n')){const i=b.indexOf('\n');let r;try{r=JSON.parse(b.slice(0,i));}catch{}b=b.slice(i+1);if(r&&pending.has(r.request_id)){pending.get(r.request_id)(r);pending.delete(r.request_id);}}});return async command=>{const request_id=++id;return new Promise((r,j)=>{const timer=setTimeout(()=>{pending.delete(request_id);j(Error('mpv timeout'));},5000);pending.set(request_id,v=>{clearTimeout(timer);if(v.error!=='success')j(Error('mpv '+v.error));else r(v.data);});pipe.write(JSON.stringify({command,request_id})+'\n');});};}
const item={id:'viewsical16',kind:'video',title:'Viewsical 1080p overlay verification',channel:'Local test media',thumbnail:null,url:'https://www.youtube.com/watch?v=viewsical16',duration:120,viewCount:null,description:null,youtubeLoudnessDb:6};
try{
 if(process.env.VIEWSICAL_TEST_EXECUTABLE){
  assert(process.env.VIEWSICAL_TEST_DATA_DIR,'Optimized tests require an explicit QA data directory');
  assert((await readFile(process.env.VIEWSICAL_TEST_EXECUTABLE)).includes(Buffer.from('app.viewsical.v016qa')),'Optimized tests require the separate QA app identity');
 }
 await mkdir(join(data,'media-cache'),{recursive:true});const entries=[];for(const [mode,suffix,source] of [['video','v.mkv','video.mkv'],['audio','a.mka','audio.mka']]){const id=randomUUID(),file=`${id}-${suffix}`;try{await link(join(root,'.tools/v016-fixture',source),join(data,'media-cache',file));}catch{await copyFile(join(root,'.tools/v016-fixture',source),join(data,'media-cache',file));}entries.push({id,video:item,mode,quality:mode==='video'?1080:0,qualities:[1080],file,bytes:(await stat(join(root,'.tools/v016-fixture',source))).size,duration:120,lastAccessed:Math.floor(Date.now()/1000),account:false,retired:false});}await writeFile(join(data,'media-cache/index.json'),JSON.stringify({enabled:true,maxBytes:512*1024*1024,entries}));
 const vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});children.push(vite);await until(async()=>(await fetch('http://127.0.0.1:1420')).ok,'Vite');
 app=spawn(process.env.VIEWSICAL_TEST_EXECUTABLE||join(root,'src-tauri/target/debug/tubedesk.exe'),[],{cwd:root,windowsHide:false,env:{...process.env,TUBEDESK_DATA_DIR:data,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});children.push(app);
 await until(async()=>{if(app.exitCode!==null)throw Object.assign(Error('Test app exited '+app.exitCode),{fatal:true});return(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(700)})).ok;},'app CDP');browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>(p.url().includes('1420')||p.url().includes('tauri.localhost')||p.url().startsWith('tauri:'))&&!p.url().includes('player-overlay')),'main page');await page.waitForSelector('#search');
 const memoryBefore=await webviewMemory(); const boot=await ipc('bootstrap');await ipc('save_settings',{settings:{...boot.settings,theme:'dark',volume:37,muted:false}});await ipc('play_video',{item,quality:1080,startSeconds:0,playbackMode:'video'});await playing();await ipc('player_action',{action:'pause'});await page.getByRole('button',{name:'Return to player',exact:true}).click();overlay=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('player-overlay=1')),'owned overlay page');await overlay.waitForSelector('.player-overlay-root');await writeFile(join(root,'.tools/v016-current.json'),JSON.stringify({pid:app.pid,port,data,profile},null,2));console.log('NATIVE_WINDOW_READY '+app.pid);console.log('OVERLAY_META',await overlay.evaluate(()=>window.__TAURI_INTERNALS__.metadata));await until(()=>ipc('plugin:window|is_visible',{label:'player-overlay'}),'overlay shown',120000);
 const memoryAfter=await webviewMemory();pass('additional reusable overlay WebView working-set observation',{before:memoryBefore,after:memoryAfter,addedMiB:(memoryAfter.bytes-memoryBefore.bytes)/1048576}); const command=await native(),get=async name=>{console.log('MPV_PROPERTY '+name);return command(['get_property',name]);};assert.equal(await get('volume-gain'),-6);assert((await get('audio-out-params'))?.format);pass('real 1080p mpv playback uses shared web overlay without Lua rendering');
 await overlay.mouse.move(overlay.viewportSize()?.width/2||150,100);await overlay.getByRole('button',{name:'Playback settings',exact:true}).click();await overlay.getByRole('menu',{name:'Playback settings',exact:true}).waitFor();assert.equal(await overlay.locator('.player-settings-menu').evaluate(el=>getComputedStyle(el).boxShadow),'none');await overlay.screenshot({path:join(root,'artifacts/v016-native-overlay-menu.png'),omitBackground:true});pass('actual overlay renders Lucide settings with shadowless shared CSS');
 await writeFile(join(root,'.tools/v016-current.json'),JSON.stringify({pid:app.pid,port,data,profile},null,2));
 console.log('NATIVE_PROBE_READY '+app.pid);
 await verify({page,overlay,ipc,invoke,get,command,until,delay,pass});
 const beforeRetry=await ipc('player_state');await ipc('retry_player_overlay');
 overlay=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>!p.isClosed()&&p.url().includes('player-overlay=1')),'replacement overlay page');
 await overlay.waitForSelector('.player-overlay-root');await until(()=>ipc('plugin:window|is_visible',{label:'player-overlay'}),'retried overlay visible');
 assert.equal((await ipc('player_state')).loadId,beforeRetry.loadId);assert.equal(await get('volume-gain'),-6);
 assert.equal(browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().includes('player-overlay=1')).length,1);
 pass('Retry controls replaces one overlay without restarting playback or normalization');
 if(process.env.VIEWSICAL_TEST_HOLD==='1')await delay(300000);
 const owned=(await webviewMemory()).ownedPids;
 pipe?.end();await ipc('plugin:window|close',{label:'main'});await until(()=>app.exitCode!==null,'clean shutdown',15000);assert.equal(app.exitCode,0);
 await until(async()=>{const {stdout}=await shell('powershell.exe',['-NoProfile','-Command',`@(Get-Process -Id ${owned.join(',')} -ErrorAction SilentlyContinue).Count`],{windowsHide:true});return Number(stdout.trim())===0;},'owned processes released',15000);
 pass('closing releases the app, mpv and owned WebView2 processes');
 await writeFile(join(root,'artifacts/v016-native-results.json'),JSON.stringify({passed:true,results},null,2));
}catch(error){if(page)try{console.log('DIAG',JSON.stringify(await ipc('player_overlay_snapshot')));}catch{}console.error(String(error));await writeFile(join(root,'artifacts/v016-native-results.json'),JSON.stringify({passed:false,results,error:String(error.stack||error)},null,2));process.exitCode=1;}
finally{pipe?.end();if(app?.exitCode===null&&page)try{await ipc('plugin:window|close',{label:'main'});await until(()=>app.exitCode!==null,'clean close',13000);}catch{}await browser?.close().catch(()=>{});for(const p of children.reverse())if(p.exitCode===null)p.kill();}
