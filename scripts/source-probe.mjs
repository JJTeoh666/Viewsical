import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const root=process.cwd();
for (const [mode,format] of [['hls','bv[protocol^=m3u8][height<=1080]+ba[protocol^=m3u8]/b[protocol^=m3u8][height<=1080]']]) {
 try {
 const {stdout}=await promisify(execFile)(resolve('tools/python/python.exe'),['-I','-B','-u','-X','utf8','-m','yt_dlp','--ignore-config','--no-cache-dir','--no-plugin-dirs','--no-warnings','--skip-download','--dump-single-json','--no-playlist','--js-runtimes',`deno:${resolve('tools/deno.exe')}`,'-f',format,'--','https://www.youtube.com/watch?v=fzQ6gRAEoy0'],{windowsHide:true,maxBuffer:32*1024*1024,timeout:90000});
 const j=JSON.parse(stdout);const sources=j.requested_formats??[j];
 for(const f of sources){const response=await fetch(f.url,{headers:{...(f.http_headers??j.http_headers??{}),Range:'bytes=0-1023'},signal:AbortSignal.timeout(20000)});console.log(JSON.stringify({mode,id:f.format_id,protocol:f.protocol,height:f.height,vcodec:f.vcodec,acodec:f.acodec,status:response.status,urlLength:f.url.length,semicolons:(f.url.match(/;/g)??[]).length}));await response.body?.cancel();}
 }catch(e){console.log(JSON.stringify({mode,error:e.name,code:e.code??'request_failed'}));}
}
