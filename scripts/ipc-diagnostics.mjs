import net from 'node:net';
const client=net.createConnection(process.argv[2]); let buffer='',serial=0;const replies=new Map();
client.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const j=JSON.parse(line);if(replies.has(j.request_id)){replies.get(j.request_id)(j);replies.delete(j.request_id);}}catch{}}});
await new Promise((r,j)=>{client.once('connect',r);client.once('error',j);});
const command=async args=>{const id=++serial;return await new Promise((r,j)=>{replies.set(id,r);client.write(JSON.stringify({command:args,request_id:id})+'\n');setTimeout(()=>j(Error('IPC timeout')),3000).unref();});};
for(const name of ['options/input-cursor','options/window-dragging','mouse-pos','input-bindings']){const r=await command(['get_property',name]);if(name==='input-bindings')r.data=r.data?.filter(b=>String(b.cmd).includes('tubedesk-pointer'));console.log(JSON.stringify({name,...r}));}
client.end();
