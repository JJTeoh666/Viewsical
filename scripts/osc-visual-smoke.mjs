import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..');
const dir=join(root,`.tools/osc-visual-${Date.now()}`), output=join(root,'artifacts');
await mkdir(dir,{recursive:true}); await mkdir(output,{recursive:true});
const video=join(dir,'neutral.mkv'), harness=join(dir,'osc-fixture.lua'), capture=join(dir,'overlay.ass.txt');
await promisify(execFile)(join(root,'tools/ffmpeg.exe'),['-v','error','-f','lavfi','-i','color=c=0x909090:s=1280x720:d=60','-an','-c:v','libx264',video],{windowsHide:true});
const luaString=value=>JSON.stringify(value.replaceAll('\\','/'));
await writeFile(harness,`local real=require('mp')
local keys,observers,actions={},{},{}
local proxy=setmetatable({},{__index=real})
function proxy.observe_property(name,kind,callback)
 if name=='mouse-pos' then observers.mouse=callback else real.observe_property(name,kind,callback) end
end
function proxy.add_forced_key_binding(key,name,callback,flags) keys[key]=callback end
function proxy.commandv(command,...)
 local args={...}
 if command=='script-message' and args[1]=='tubedesk-control' then actions[#actions+1]=args else return real.commandv(command,...) end
end
function proxy.create_osd_overlay(kind)
 local overlay=real.create_osd_overlay(kind)
 local wrapper={}
 function wrapper:update()
  local file=assert(io.open(${luaString(capture)},'w'));file:write(self.data or '');file:close()
  overlay.data=self.data;overlay.res_x=self.res_x;overlay.res_y=self.res_y
  return overlay:update()
 end
 return wrapper
end
package.loaded.mp=proxy
dofile(${luaString(join(root,'resources/player/tubedesk_osc.lua'))})
package.loaded.mp=real
real.register_script_message('fixture-pointer',function(x,y,hover)
 observers.mouse('mouse-pos',{x=tonumber(x),y=tonumber(y),hover=hover~='false'})
end)
real.register_script_message('fixture-click',function()
 keys.MBTN_LEFT({event='down'});keys.MBTN_LEFT({event='up'})
end)
real.register_script_message('fixture-actions',function()
 real.set_property('user-data/fixture-actions',require('mp.utils').format_json(actions))
end)
`);
const pipe=[String.fromCharCode(92,92),'.',String.fromCharCode(92),'pipe',String.fromCharCode(92),'viewsical-osc-visual-',Date.now()].join('');
const child=spawn(join(root,'tools/mpv.exe'),['--no-config','--load-scripts=no','--no-terminal','--osc=no','--ao=null','--pause=yes','--idle=yes','--force-window=yes','--window-minimized=yes','--geometry=1280x720',`--script=${harness}`,`--input-ipc-server=${pipe}`,`--log-file=${join(dir,'mpv.log')}`,video],{windowsHide:true});
let client;let serial=0,buf='';const replies=new Map();const results=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,passed)=>{results.push({name,passed});assert(passed,name);};
try{
 for(let i=0;i<120;i++){try{const socket=net.createConnection(pipe);await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j);});client=socket;break;}catch(error){if(i===119)console.error(error);await pause(50);}}
 assert(client,'mpv IPC started');
 client.on('data',b=>{buf+=b;while(buf.includes('\n')){const i=buf.indexOf('\n'),line=buf.slice(0,i);buf=buf.slice(i+1);try{const value=JSON.parse(line);if(replies.has(value.request_id)){replies.get(value.request_id)(value);replies.delete(value.request_id);}}catch{}}});
 const command=args=>new Promise((r,j)=>{const request_id=++serial;replies.set(request_id,r);client.write(JSON.stringify({command:args,request_id})+'\n');setTimeout(()=>j(Error('OSC IPC timeout')),7000).unref();});
 const message=async(...args)=>{const result=await command(['script-message',...args.map(String)]);assert.equal(result.error,'success');await pause(180);};
 let dims;
 for(let i=0;i<50;i++){dims=(await command(['get_property','osd-dimensions'])).data;if(dims?.w>0)break;await pause(100);}
 assert(dims?.w>0,'video output initialized');
 const {w,h}=dims,scale=Math.min(1.5,Math.max(1.2,w/1000)),size=42*scale;
 const pointer=(x,y,hover=true)=>message('fixture-pointer',x,y,hover);
 const click=async(x,y)=>{await pointer(x,y);await message('fixture-click');};
 const context={loadId:7,mode:'video',quality:1080,qualities:[720,1080,480],hasPrevious:true,hasNext:true,title:'Viewsical native controls',mini:false};
 await message('context',JSON.stringify(context));await pointer(w/2,h/2);
 await command(['screenshot-to-file',join(output,'v015-native-gradient.png'),'window']);
 const {stdout: pixels}=await promisify(execFile)(join(root,'tools/ffmpeg.exe'),['-v','error','-i',join(output,'v015-native-gradient.png'),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024});
 const fadeSteps=(start,end)=>Array.from({length:end-start-1},(_,i)=>Math.abs(pixels[(start+i+1)*w*3]-pixels[(start+i)*w*3]));
 check('rendered fades have no abrupt luminance bands',Math.max(...fadeSteps(0,Math.ceil(84*scale)),...fadeSteps(Math.floor(h-130*scale),h))<=4);
 let ass=await readFile(capture,'utf8');
 const rowClips=[...ass.matchAll(/\\clip\(0,(\d+),(\d+),(\d+)\)/g)].map(m=>[+m[1],+m[3]]);
 check('gradient uses physical one-pixel clips',rowClips.length>200&&rowClips.every(([a,b])=>b-a===1));
 check('gradient no longer draws coarse strips',!ass.includes('band='));
 const y=h-56*scale+5*scale;
 const settingsX=w-size-5*scale-2*size;
 await click(settingsX+size/2,y+size/2);
 ass=await readFile(capture,'utf8');
 check('native menu matches audio row order',ass.indexOf('Playback mode')<ass.indexOf('Playback speed')&&ass.indexOf('Playback speed')<ass.indexOf('Quality'));
 check('root menu has no extra Settings heading',!ass.includes('}Settings\n'));
 await command(['screenshot-to-file',join(output,'v015-native-settings.png'),'window']);
 const bottom=h-56*scale-22*scale,panelW=305*scale,panelH=(3*44+14)*scale,panelX=w-panelW-12*scale,panelY=bottom-panelH;
 await click(panelX+panelW/2,panelY+(7+22)*scale);
 ass=await readFile(capture,'utf8');
 check('playback mode opens matching submenu',ass.includes('}Playback mode\n')&&ass.includes('}Video\n')&&ass.includes('}Audio only\n'));
 await command(['screenshot-to-file',join(output,'v015-native-mode-menu.png'),'window']);
 await click(panelX+panelW/2,panelY+(7+44+44+22)*scale);
 await message('fixture-actions');
 const actions=JSON.parse((await command(['get_property','user-data/fixture-actions'])).data);
 check('audio-only row dispatches scoped mode action',actions.some(a=>a[1]==='7'&&a[2]==='mode'&&a[3]==='audio'));
 await message('context',JSON.stringify({...context,loadId:8}));await click(settingsX+size/2,y+size/2);await pointer(-1,-1,false);
 ass=await readFile(capture,'utf8');
 check('pointer leave clears controls and settings',ass==='');
 const log=await readFile(join(dir,'mpv.log'),'utf8');
 check('native script ran without Lua errors',!log.includes('Lua error')&&!log.includes('stack traceback'));
 await writeFile(join(output,'v015-native-osc-results.json'),JSON.stringify({passed:true,dimensions:dims,results},null,2));
 console.log(JSON.stringify({passed:true,results,dir},null,2));
 await command(['quit']);
}finally{client?.end();if(child.exitCode===null)child.kill();}
