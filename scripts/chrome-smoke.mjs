// Real anonymous native playback, persistent media caching and read-only comments.
// Uses separate app data/WebView profile; never alters the user's saved account.
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=join(root,'artifacts');
const stamp=Date.now(),data=join(root,`.tools/chrome-test-${stamp}`),profile=join(root,`.tools/chrome-webview-${stamp}`),port=9328;
const delay=ms=>new Promise(r=>setTimeout(r,ms)),children=[],results=[];let app,browser,page,pipe;
await mkdir(out,{recursive:true});
const pass=(name,details={})=>{console.log(`PASS ${name}`);results.push({name,passed:true,...details});};
async function until(fn,label,timeout=90000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){if(e.fatal)throw e;last=e;}await delay(250);}throw Error(`${label}: ${last?.message??'timed out'}`);}
const shell=promisify(execFile);
async function ipc(command,args={}) { const r=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error};}},{command,args});if(!r.ok)throw Object.assign(Error(r.error?.message??String(r.error)),r.error);return r.value; }
async function launch(){app=spawn(join(root,'src-tauri/target/debug/tubedesk.exe'),[],{cwd:root,windowsHide:false,env:{...process.env,TUBEDESK_DATA_DIR:data,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});children.push(app);await until(async()=>{if(app.exitCode!==null)throw Object.assign(Error(`App exited ${app.exitCode}`),{fatal:true});return (await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)})).ok;},'app endpoint',30000);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420')),'app UI');page.on('pageerror',error=>console.error('TEST WEBVIEW ERROR:',error.message)); await page.waitForSelector('#search',{timeout:60000}).catch(async error=>{console.error('TEST PAGE:',page.url(),(await page.locator('body').innerText()).slice(0,2000));throw error;});}
async function close(){await pipe?.close();pipe=null;await ipc('plugin:window|close',{label:'main'});await until(()=>app.exitCode!==null,'clean app close',13000);assert.equal(app.exitCode,0);await browser.close().catch(()=>{});browser=null;}
async function engine(){
 const r=await shell('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${app.pid} -and $_.Name -eq 'mpv.exe' } | Select-Object -ExpandProperty CommandLine`],{windowsHide:true});
 const match=r.stdout.match(/--input-ipc-server=(?:"([^"]+)"|([^\s]+))/);assert(match,'owned mpv IPC endpoint');
 const client=net.createConnection(match[1]??match[2]);await new Promise((r,j)=>{client.once('connect',r);client.once('error',j);});
 let buffer='',serial=0;const replies=new Map(),warnings=[];client.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const v=JSON.parse(line);if(replies.has(v.request_id)){replies.get(v.request_id)(v);replies.delete(v.request_id);}else if(v.event==='log-message'){warnings.push({prefix:v.prefix,text:String(v.text).replace(/https?:\/\/[^\s'"]+/g,'<source>').slice(0,800)});}}catch{}}});
 return {warnings,command:args=>new Promise((r,j)=>{const id=++serial;replies.set(id,r);client.write(JSON.stringify({command:args,request_id:id})+'\n');setTimeout(()=>j(Error('Native IPC timeout')),4000).unref();}),close:async()=>client.end()};
}
async function sound(){
 const get=async name=>(await pipe.command(['get_property',name])).data;
 const tracks=(await get('track-list')??[]).filter(t=>t.type==='audio').map(t=>({id:t.id,selected:!!t.selected,external:!!t.external,codec:t.codec}));
 const decoded=await get('audio-params'),output=await get('audio-out-params');
 return {tracks,decoded:decoded?{format:decoded.format,samplerate:decoded.samplerate,channels:decoded.channels}:null,output:output?{format:output.format,samplerate:output.samplerate,channels:output.channels}:null,muted:await get('mute'),volume:await get('volume')};
}
async function playing(){return until(async()=>{const s=await ipc('player_state');if(s.status==='failed')throw Object.assign(Error(`${s.errorCode}: ${s.error}`),{fatal:true});return s.status==='playing'&&s.position>0.5?s:null;},'native playback',120000);}
const video=(id,title)=>({id,kind:'video',title,channel:'YouTube',url:`https://www.youtube.com/watch?v=${id}`,thumbnail:null,duration:null,viewCount:null,description:null});
try {
 const vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});children.push(vite);
 await until(async()=>(await fetch('http://127.0.0.1:1420',{signal:AbortSignal.timeout(1000)})).ok,'Vite',15000);await launch();
 const boot=await ipc('bootstrap'); assert.equal(boot.settings.alwaysAudioOnly,false);
 assert.equal(await ipc('plugin:window|is_decorated',{label:'main'}),false);pass('native window has integrated frameless header');
 await page.getByRole('button',{name:'Maximize window',exact:true}).click();await until(async()=>await ipc('plugin:window|is_maximized',{label:'main'}),'maximize');
 await page.getByRole('button',{name:'Restore window',exact:true}).click();await until(async()=>!(await ipc('plugin:window|is_maximized',{label:'main'})),'restore');pass('custom maximize and restore buttons work through scoped permissions');
 await ipc('cache_configure',{enabled:false,maxBytes:512*1024*1024});
 await page.locator('.sidebar').getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('switch',{name:'Always start with audio only',exact:true}).click();await until(async()=>(await ipc('bootstrap')).settings.alwaysAudioOnly,'saved audio setting');
 await ipc('save_settings',{settings:{...(await ipc('bootstrap')).settings,volume:12,muted:false}});
 const zoo=video('jNQXAC9IVRw','Me at the zoo');await ipc('play_video',{item:zoo,quality:360,startSeconds:1,playbackMode:'video'});await playing();pipe=await engine();
 assert.equal((await ipc('player_state')).playbackMode,'audio');const audio=await sound();assert(audio.tracks.some(t=>t.selected)&&audio.output&&audio.decoded);pass('saved audio default overrides a new explicit-video request and produces native audio');
 await ipc('player_action',{action:'pause'});await ipc('set_playback_mode',{mode:'video'});await until(async()=>{const state=await ipc('player_state');return state.playbackMode==='video'&&state.status==='paused';},'manual video override');
 await page.getByRole('button',{name:'Move player to bottom bar',exact:true}).click();await page.getByRole('region',{name:'Bottom player',exact:true}).waitFor();
 const before=await ipc('player_state');await page.getByRole('button',{name:'Play (Space)',exact:true}).click();await playing();await delay(1800);const after=await ipc('player_state');assert.equal(after.loadId,before.loadId);assert(after.position>before.position);assert((await sound()).output);pass('docked player keeps the native source and audio advancing');
 await page.getByRole('button',{name:'Pause (Space)',exact:true}).click();await page.getByRole('button',{name:'Restore floating mini player',exact:true}).click();await page.getByRole('region',{name:'Mini player',exact:true}).waitFor();assert.equal((await ipc('player_state')).loadId,before.loadId);pass('native playback survives dock and undock without a new load');
 await page.screenshot({path:join(out,'v013-native-header.png')});
 await close();await launch();assert.equal((await ipc('bootstrap')).settings.alwaysAudioOnly,true);assert.equal((await ipc('player_state')).playbackMode,'audio');pass('audio-only preference and starting player mode survive app restart');
 await ipc('play_video',{item:zoo,quality:360,startSeconds:1,playbackMode:'video'});await playing();assert.equal((await ipc('player_state')).playbackMode,'audio');pass('first video after restart starts audio-only');
 await page.getByRole('button',{name:'Minimize window',exact:true}).click();await until(async()=>await ipc('plugin:window|is_minimized',{label:'main'}),'minimize');pass('custom minimize button works');
 await close();pass('custom close exits cleanly with playback active');
 await writeFile(join(out,'v013-native-chrome-results.json'),JSON.stringify({passed:true,results},null,2));
} catch(error) {console.error(error);await writeFile(join(out,'v013-native-chrome-results.json'),JSON.stringify({passed:false,results,error:String(error.stack||error)},null,2));process.exitCode=1;}
finally {await pipe?.close();await browser?.close().catch(()=>{});for(const p of children.reverse())if(p.exitCode===null)p.kill();}
