import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
const root=resolve(import.meta.dirname,'..'),dir=join(root,`.tools/normalization-${Date.now()}`),run=promisify(execFile);
await mkdir(dir,{recursive:true});
const mpv=join(root,'tools/mpv.exe'),ffmpeg=join(root,'tools/ffmpeg.exe'),tone=join(dir,'tone.wav');
await run(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1:sample_rate=48000','-c:a','pcm_s16le',tone],{windowsHide:true});
const checks=[],pass=(name,evidence)=>{checks.push({name,passed:true,...evidence});console.log('PASS '+name);};
async function render(name,volume,gain){
 const file=join(dir,`${name}.wav`);
 await run(mpv,['--no-config','--load-scripts=no','--no-terminal','--vo=null','--ao=pcm','--audio-format=float',`--ao-pcm-file=${file}`,`--volume=${volume}`,`--volume-gain=${gain}`,tone],{windowsHide:true});
 const {stdout}=await run(ffmpeg,['-v','error','-i',file,'-f','f32le','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:1024*1024,windowsHide:true});
 let sum=0;for(let i=0;i+3<stdout.length;i+=4){const v=stdout.readFloatLE(i);sum+=v*v;}
 return Math.sqrt(sum/(stdout.length/4));
}
for(const volume of [37,80,100]){
 const neutral=await render('neutral-'+volume,volume,0),normalized=await render('normalized-'+volume,volume,-6),ratio=normalized/neutral;
 assert(Math.abs(ratio-10**(-6/20))<0.002,`Actual PCM gain wrong at volume${volume}: ${ratio}`);
 pass('rendered PCM applies -6 dB independently of user volume '+volume,{ratio,expected:10**(-6/20)});
}
const pipe=`\\\\.\\pipe\\viewsical-normalization-${Date.now()}`;
const child=spawn(mpv,['--idle=yes','--no-config','--no-terminal','--vo=null','--ao=null',`--input-ipc-server=${pipe}`],{windowsHide:true,stdio:'ignore'});
let client;
try{
 for(let i=0;i<100;i++){try{client=net.createConnection(pipe);await new Promise((r,j)=>{client.once('connect',r);client.once('error',j);});break;}catch{client?.destroy();await new Promise(r=>setTimeout(r,50));}}
 assert(client&&!client.destroyed,'native IPC unavailable');
 let serial=0,buffer='';const pending=new Map();
 client.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),j=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(pending.has(j.request_id)){pending.get(j.request_id)(j);pending.delete(j.request_id);}}});
 async function command(args){const id=++serial;return new Promise((r,j)=>{const timer=setTimeout(()=>{pending.delete(id);j(Error('IPC timeout'));},5000);pending.set(id,v=>{clearTimeout(timer);assert.equal(v.error,'success',JSON.stringify(args));r(v.data);});client.write(JSON.stringify({command:args,request_id:id})+'\n');});}
 for(const gain of [-6,0,-3,0]){
  await command(['loadfile',tone,'replace',-1,{pause:'yes','volume-gain':String(gain)}]);await new Promise(r=>setTimeout(r,250));
  assert.equal(await command(['get_property','volume-gain']),gain);
 }
 pass('file-local gain resets on missing metadata, refresh and source changes');
 await command(['set_property','volume',37]);await command(['set_property','volume-gain',-6]);
 assert.equal(await command(['get_property','volume']),37);
 await command(['set_property','volume-gain',0]);assert.equal(await command(['get_property','volume']),37);
 pass('live normalization toggle preserves user-volume property');
 await command(['quit']);
}finally{client?.end();if(child.exitCode===null)child.kill();}
await writeFile(join(root,'artifacts/v015-normalization-results.json'),JSON.stringify({passed:true,checks},null,2));
