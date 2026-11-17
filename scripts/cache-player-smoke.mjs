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
const stamp=Date.now(),data=join(root,`.tools/cache-test-${stamp}`),profile=join(root,`.tools/cache-webview-${stamp}`),port=9327;
const delay=ms=>new Promise(r=>setTimeout(r,ms)),children=[],results=[];let app,browser,page,pipe;
await mkdir(out,{recursive:true});
const pass=(name,details={})=>{console.log(`PASS ${name}`);results.push({name,passed:true,...details});};
async function until(fn,label,timeout=90000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){if(e.fatal)throw e;last=e;}await delay(250);}throw Error(`${label}: ${last?.message??'timed out'}`);}
const shell=promisify(execFile);
async function ipc(command,args={}) { const r=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error};}},{command,args});if(!r.ok)throw Object.assign(Error(r.error?.message??String(r.error)),r.error);return r.value; }
async function launch(){app=spawn(join(root,'src-tauri/target/debug/tubedesk.exe'),[],{cwd:root,windowsHide:false,env:{...process.env,TUBEDESK_DATA_DIR:data,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});children.push(app);await until(async()=>{if(app.exitCode!==null)throw Object.assign(Error(`App exited ${app.exitCode}`),{fatal:true});return (await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)})).ok;},'app endpoint',30000);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420')),'app UI');await page.waitForSelector('#search');}
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
try{
 const vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});children.push(vite);
 await until(async()=>(await fetch('http://127.0.0.1:1420',{signal:AbortSignal.timeout(1000)})).ok,'Vite',15000);await launch();
 const boot=await ipc('bootstrap');await ipc('save_settings',{settings:{...boot.settings,volume:18,muted:false}});
 if(process.env.TUBEDESK_AUDIO_DIAGNOSTIC==='1'){
   const first=video('jNQXAC9IVRw','Me at the zoo');await ipc('play_video',{item:first,quality:360,startSeconds:0,playbackMode:'video'});await playing();pipe=await engine();await pipe.command(['request_log_messages','warn']);
   await until(async()=>{const s=await ipc('cache_summary');return s.entryCount>=2;},'prelude cache',90000);await ipc('play_video',{item:first,quality:360,startSeconds:2,playbackMode:'video'});await playing();await ipc('player_action',{action:'pause'});await ipc('set_playback_mode',{mode:'audio'});await ipc('set_playback_mode',{mode:'video'});await ipc('cache_clear',{kind:'all',entryId:null});await ipc('player_action',{action:'stop'});
   await ipc('play_video',{item:video('fzQ6gRAEoy0','Shelter'),quality:1080,startSeconds:0,playbackMode:'video'});
   const samples=[];for(let i=0;i<40;i++){const s=await ipc('player_state'),a=await sound();samples.push({status:s.status,errorCode:s.errorCode,position:s.position,...a});if(s.status==='failed')break;await delay(500);}
   await writeFile(join(out,'v012-audio-diagnostics.json'),JSON.stringify({samples,warnings:pipe.warnings},null,2));
   console.log(JSON.stringify({samples:samples.filter((_,i)=>i%4===0||i===samples.length-1),warnings:pipe.warnings}));await close();throw Object.assign(Error('Diagnostics completed'),{diagnosticComplete:true});
 }
 const initialCache=await ipc('cache_summary');assert(initialCache.enabled);assert.equal(initialCache.entryCount,0);
 const comments=await ipc('video_comments',{videoId:'fzQ6gRAEoy0',cursor:null,sort:'top',requestId:'smoke-top'});assert(comments.items.length>0);assert(comments.nextCursor);assert(comments.items.every(c=>c.text&&c.author));
 const more=await ipc('video_comments',{videoId:'fzQ6gRAEoy0',cursor:comments.nextCursor,sort:'top',requestId:'smoke-more'});assert(more.items.length>0);assert(more.items.some(c=>!comments.items.some(first=>first.id===c.id)));assert.equal(new Set(more.items.map(c=>c.id)).size,more.items.length);
 const newest=await ipc('video_comments',{videoId:'fzQ6gRAEoy0',cursor:null,sort:'newest',requestId:'smoke-new'});assert(newest.items.length>0);pass('real read-only top/newest comments and continuation',{firstPage:comments.items.length,secondPage:more.items.length,newest:newest.items.length});
 const zoo=video('jNQXAC9IVRw','Me at the zoo');await ipc('play_video',{item:zoo,quality:360,startSeconds:0,playbackMode:'video'});await playing();pipe=await engine();
 const audio=await until(async()=>{const s=await sound();return s.tracks.some(t=>t.selected)&&s.decoded&&s.output?s:null;},'selected decoded audio/output');assert.equal(audio.muted,false);assert(audio.volume>0);pass('video has selected decoded audio and an open native output',{audio});
 const cached=await until(async()=>{const s=await ipc('cache_summary');return s.entries.some(e=>e.videoId===zoo.id&&e.mode==='audio')&&s.entries.some(e=>e.videoId===zoo.id&&e.mode==='video')?s:null;},'complete internal audio/video cache',120000);assert(cached.totalBytes>0);assert(cached.totalBytes<=cached.maxBytes);pass('played media produces complete persistent audio/video cache',{bytes:cached.totalBytes,entries:cached.entryCount});
 // Independently confirm both files have real tracks, full duration, and no
 // signed URL fields persisted in the index.
 const index=JSON.parse(await readFile(join(data,'media-cache/index.json'),'utf8'));assert(!JSON.stringify(index).includes('googlevideo.com'));
 for(const e of index.entries){const p=join(data,'media-cache',e.file);assert((await stat(p)).size===e.bytes);const probe=JSON.parse((await shell(join(root,'tools/ffprobe.exe'),['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',p],{windowsHide:true})).stdout);assert(probe.streams.some(s=>s.codec_type===e.mode));assert(Number(probe.format.duration)>16);}
 const audioFile=join(data,'media-cache',index.entries.find(e=>e.mode==='audio').file);const levels=await shell(join(root,'tools/ffmpeg.exe'),['-nostdin','-hide_banner','-i',audioFile,'-t','8','-af','volumedetect','-f','null','NUL'],{windowsHide:true});assert(/mean_volume: (?!-inf)[\d.-]+ dB/.test(levels.stderr));pass('cached files independently validated, including a non-silent audio signal');
 await ipc('play_video',{item:zoo,quality:360,startSeconds:2,playbackMode:'video'});await playing();const source=(await pipe.command(['get_property','path'])).data;assert(String(source).startsWith(join(data,'media-cache')));assert((await ipc('cache_summary')).entries.some(e=>e.pinned));pass('replay opens pinned internal cache without source extraction');
 await ipc('player_action',{action:'pause'});await ipc('player_action',{action:'seek',value:5});await ipc('set_playback_mode',{mode:'audio'});await until(async()=>{const s=await ipc('player_state');return s.status==='paused'&&s.playbackMode==='audio'&&s.position>=4;},'cached audio switch');const aPath=(await pipe.command(['get_property','path'])).data;assert(String(aPath).endsWith('.mka'));await ipc('set_playback_mode',{mode:'video'});await until(async()=>{const s=await ipc('player_state');return s.status==='paused'&&s.playbackMode==='video'&&s.position>=4;},'cached video return');pass('cached audio/video switches preserve pause and position');
 const downloadsBefore=(await ipc('bootstrap')).downloads;const cleared=await ipc('cache_clear',{kind:'all',entryId:null});assert(cleared.entries.every(e=>e.pinned));await ipc('player_action',{action:'stop'});await until(async()=>(await ipc('cache_summary')).entryCount===0,'deferred active cache removal');assert.deepEqual((await ipc('bootstrap')).downloads,downloadsBefore);pass('clear safely defers active files then removes them without touching downloads');
 const shelter=video('fzQ6gRAEoy0','Shelter');await ipc('play_video',{item:shelter,quality:1080,startSeconds:0,playbackMode:'video'});await playing();await until(async()=>{const s=await sound();return s.tracks.some(t=>t.selected)&&s.decoded&&s.output;},'Shelter separate audio');
 const samples=[];for(let i=0;i<15;i++){await delay(2000);const s=await ipc('player_state'),a=await sound();assert(!['failed','resolving','ended'].includes(s.status));assert(a.tracks.some(t=>t.selected));assert(a.decoded&&a.output);samples.push({position:s.position,status:s.status,hasAudio:true});}assert(samples.at(-1).position>24);pass('reported video plays continuously with decoded audio during cache work',{samples});
 await ipc('set_playback_mode',{mode:'audio'});await playing();await until(async()=>{const a=await sound();return a.tracks.some(t=>t.selected)&&a.output;},'online audio output');await ipc('set_playback_mode',{mode:'video'});await playing();pass('online audio/video transitions keep working audio');
 // Complete a short cache again, close/reopen, and verify local media persists.
 await ipc('play_video',{item:zoo,quality:360,startSeconds:1,playbackMode:'video'});await playing();await until(async()=>{const s=await ipc('cache_summary');return s.entries.some(e=>e.videoId===zoo.id&&e.mode==='video')&&s.entries.some(e=>e.videoId===zoo.id&&e.mode==='audio');},'short cache restored',120000);
 await close();await launch();const reopened=await ipc('cache_summary');assert(reopened.entries.some(e=>e.videoId===zoo.id));await ipc('play_video',{item:zoo,quality:360,startSeconds:2,playbackMode:'video'});await playing();pipe=await engine();const persistedSource=(await pipe.command(['get_property','path'])).data;assert(String(persistedSource).startsWith(join(data,'media-cache')));const persistedAudio=await sound();assert(persistedAudio.tracks.some(t=>t.selected)&&persistedAudio.output);pass('restart reuses persistent cache with native audio');
 await ipc('cache_configure',{enabled:false,maxBytes:512*1024*1024});const configured=await ipc('cache_summary');assert.equal(configured.enabled,false);assert.equal(configured.maxBytes,512*1024*1024);await close();await launch();assert.equal((await ipc('cache_summary')).enabled,false);await close();pass('cache settings survive restart and app closes cleanly');
 await writeFile(join(out,'v012-cache-player-results.json'),JSON.stringify({passed:true,results},null,2));
}catch(error){if(!error.diagnosticComplete){console.error(error);await writeFile(join(out,'v012-cache-player-results.json'),JSON.stringify({passed:false,results,error:String(error.stack||error)},null,2));process.exitCode=1;}}
finally{await pipe?.close();await browser?.close().catch(()=>{});for(const p of children.reverse())if(p.exitCode===null)p.kill();}
