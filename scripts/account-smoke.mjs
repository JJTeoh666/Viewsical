// Uses only TubeDesk's existing app-owned session. Never signs out or enters credentials.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),delay=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];let app,browser,page,vite;
async function until(fn,label,timeout=90000){let last;const end=Date.now()+timeout;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await delay(400);}throw Error(`${label}: ${last?.message??'timed out'}`);}
async function invoke(command,args={}){const r=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(e){return {ok:false,error:e};}},{command,args});if(!r.ok)throw Object.assign(Error(r.error?.message??String(r.error)),r.error);return r.value;}
async function launch(){app=spawn(join(root,'src-tauri/target/debug/tubedesk.exe'),[],{cwd:root,windowsHide:false,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9224'},stdio:'ignore'});await until(async()=>(await fetch('http://127.0.0.1:9224/json/version',{signal:AbortSignal.timeout(1000)})).ok,'WebView');browser=await chromium.connectOverCDP('http://127.0.0.1:9224');page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420')),'main');await page.waitForSelector('#search');return await until(async()=>{const s=await invoke('session_state');return s.status!=='restoring'?s:null;},'automatic remembered sign-in');}
async function close(){await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}));await until(()=>app.exitCode!==null,'app clean shutdown',13000);await browser.close().catch(()=>{});browser=null;}
try{vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});await until(async()=>(await fetch('http://127.0.0.1:1420',{signal:AbortSignal.timeout(1000)})).ok,'Vite',15000);
 let s=await launch();assert.equal(s.status,'connected',s.message??s.status);results.push({name:'existing remembered account automatically validates',passed:true});console.log('PASS existing account automatically restored');
 const p=await invoke('browse',{kind:'playlists',query:'',cursor:null,requestId:'remember-check'});results.push({name:'authenticated playlist library',passed:true,count:p.items.length});console.log(`PASS authenticated playlists (${p.items.length} returned)`);
 const playlist=p.items.find(x=>x.kind==='playlist'&&!x.id.startsWith('RD'));
 if(playlist){const entries=await invoke('browse',{kind:'playlist',query:playlist.url,cursor:null,requestId:'remember-contents'});results.push({name:'authenticated playlist contents',passed:true,count:entries.items.length});console.log(`PASS authenticated playlist contents (${entries.items.length} returned)`);}
 await close();results.push({name:'signed-in main close exits',passed:true});
 s=await launch();assert.equal(s.status,'connected',s.message??s.status);results.push({name:'signed-in account remembered after clean restart',passed:true});await close();console.log('PASS login remains connected after close/restart');
 await writeFile(join(root,'artifacts/v011-account-results.json'),JSON.stringify({passed:true,results},null,2));
}catch(error){console.error(error.message);await writeFile(join(root,'artifacts/v011-account-results.json'),JSON.stringify({passed:false,results,error:error.message,code:error.code},null,2));process.exitCode=1;}
finally{await browser?.close().catch(()=>{});if(app?.exitCode===null)app.kill();if(vite?.exitCode===null)vite.kill();}
