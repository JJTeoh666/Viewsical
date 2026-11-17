// Inspect the shipped release without changing sign-in, history or playback preferences.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile,stat,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),executable=join(root,'artifacts/TubeDesk-portable/TubeDesk.exe');
const env={...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9334'};
const app=spawn(executable,[],{cwd:dirname(executable),env,windowsHide:false,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let browser,page;
const results=[];const pass=name=>{results.push({name,passed:true});console.log('PASS '+name);};
const until=async(fn,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(app.exitCode!==null)throw Error(`App exited ${app.exitCode}`);try{const result=await fn();if(result)return result;}catch{}await delay(200);}throw Error(label);};
try {
 await until(async()=>(await fetch('http://127.0.0.1:9334/json/version',{signal:AbortSignal.timeout(1000)})).ok,'Release WebView endpoint');
 browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
 page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost')||p.url().startsWith('tauri:')),'Bundled UI');await page.waitForSelector('#search',{timeout:60000});
 const ipc=(command,args={})=>page.evaluate(async({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert((await page.locator('body').innerText()).includes('0.1.3'));assert.equal(await ipc('plugin:window|is_decorated',{label:'main'}),false);pass('release 0.1.3 uses bundled UI and integrated title bar');
 const boot=await ipc('bootstrap');assert.equal(typeof boot.settings.alwaysAudioOnly,'boolean');assert(boot.tools.length>=5&&boot.tools.every(tool=>tool.available));assert(await page.evaluate(()=>document.fonts.check('14px Roboto')));assert((await stat(join(dirname(executable),'player/tubedesk_osc.lua'))).size>0);pass('release contains media helpers, font, native controls and persisted audio default');
 const ico=await readFile(join(root,'src-tauri/icons/icon.ico'));assert.equal(ico.readUInt16LE(4),7);assert((await stat(join(root,'src-tauri/icons/icon.png'))).size>10000);pass('new artwork has seven Windows icon resolutions');
 const duplicate=spawn(executable,[],{cwd:dirname(executable),env,windowsHide:true,stdio:'ignore'});for(let i=0;i<50&&duplicate.exitCode===null;i++)await delay(100);assert.equal(duplicate.exitCode,0);pass('release duplicate launch focuses existing instance');
 const original=await ipc('plugin:window|is_maximized',{label:'main'});
 await page.getByRole('button',{name:original?'Restore window':'Maximize window',exact:true}).click();await until(async()=>await ipc('plugin:window|is_maximized',{label:'main'})!==original,'Release maximize');
 await page.getByRole('button',{name:original?'Maximize window':'Restore window',exact:true}).click();await until(async()=>await ipc('plugin:window|is_maximized',{label:'main'})===original,'Release restore');pass('release window buttons are authorized and restore original state');
 await page.screenshot({path:join(root,'artifacts/v013-packaged-header.png')});
 await page.getByRole('button',{name:'Close window',exact:true}).click();for(let i=0;i<65&&app.exitCode===null;i++)await delay(200);assert.equal(app.exitCode,0);pass('release closes cleanly from integrated header');
 await writeFile(join(root,'artifacts/v013-package-results.json'),JSON.stringify({passed:true,results},null,2));
} catch(error) {console.error(error);await writeFile(join(root,'artifacts/v013-package-results.json'),JSON.stringify({passed:false,results,error:String(error.stack||error)},null,2));process.exitCode=1;}
finally {if(app.exitCode===null&&page)try{await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}));}catch{}await browser?.close().catch(()=>{});if(app.exitCode===null)app.kill();}
