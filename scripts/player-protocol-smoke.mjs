import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),dir=join(root,`.tools/protocol-${Date.now()}`);await mkdir(dir,{recursive:true});
const ffmpeg=join(root,'tools/ffmpeg.exe'),video=join(dir,'video.mkv'),audio=join(dir,'audio;track.mka'),run=promisify(execFile);
await run(ffmpeg,['-v','error','-f','lavfi','-i','color=black:s=160x90:d=10','-an','-c:v','libx264',video],{windowsHide:true});
await run(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=10','-c:a','pcm_s16le',audio],{windowsHide:true});
const path=`\\\\.\\pipe\\tubedesk-protocol-${Date.now()}`,child=spawn(join(root,'tools/mpv.exe'),['--idle=yes','--no-config','--load-scripts=no','--no-terminal','--vo=null','--ao=null',`--input-ipc-server=${path}`],{windowsHide:true});
let client;try{
 for(let i=0;i<100;i++){try{client=net.createConnection(path);await new Promise((r,j)=>{client.once('connect',r);client.once('error',j);});break;}catch{await new Promise(r=>setTimeout(r,50));}}
 let serial=0,buf='';const replies=new Map();client.on('data',b=>{buf+=b;while(buf.includes('\n')){const i=buf.indexOf('\n'),line=buf.slice(0,i);buf=buf.slice(i+1);try{const j=JSON.parse(line);if(replies.has(j.request_id)){replies.get(j.request_id)(j);replies.delete(j.request_id);}}catch{}}});
 child.on('exit',(code,signal)=>console.log(JSON.stringify({exit:code,signal})));
 const command=(args,async=false)=>new Promise((r,j)=>{const id=++serial;replies.set(id,r);client.write(JSON.stringify({command:args,request_id:id,async})+'\n');setTimeout(()=>j(Error('native protocol timeout')),5000).unref();});
 const commands=[['clear',['set_property','audio-files',[]]],['pair',['set_property','audio-files',[audio]]],['load',['loadfile',video,'replace',-1,{pause:'yes',aid:'auto'}]],['tracks',['get_property','track-list']]];
 for(const [name,args] of commands){if(name==='tracks')await new Promise(r=>setTimeout(r,500));const result=await command(args);assert.equal(result.error,'success');if(name==='tracks')assert(result.data.some(t=>t.type==='audio'&&t.external&&t.selected));console.log(`PASS typed native ${name}`);}
 await command(['stop']);await command(['set_property','audio-files',[]]);await command(['loadfile',audio,'replace',-1,{pause:'yes',vid:'no',aid:'auto'}]);await new Promise(r=>setTimeout(r,500));const tracks=await command(['get_property','track-list']);assert(tracks.data.some(t=>t.type==='audio'&&t.selected&&!t.external));console.log('PASS audio-only reset keeps the semicolon path as one source');
 await command(['quit']);
}finally{client?.end();if(child.exitCode===null)child.kill();}
