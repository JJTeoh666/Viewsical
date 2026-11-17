import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts');
const results = [];
const check = (name, passed, detail) => { results.push({ name, passed, detail }); if (!passed) throw new Error(name); };
const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import {PlayerHost} from '/src/PlayerHost.tsx';
import {defaultPlayer} from '/src/types.ts';
function Fixture(){
 const [mini,setMini]=useState(true), [docked,setDocked]=useState(false), [audio,setAudio]=useState(false);
 const player={...defaultPlayer,status:'playing',position:42,duration:215,loadId:7,video:{id:'fixture',title:'A long evening with a very long video title',channel:'TubeDesk Music',thumbnail:null,url:'https://www.youtube.com/watch?v=fixture',kind:'video',duration:215,viewCount:null,description:null},playbackMode:audio?'audio':'video',qualities:[1080,720]};
 return <div className={'app '+(docked?'has-bottom-player':'')}><div style={{padding:'80px 30px'}}><h1>Player layout fixture</h1><button id="audio" onClick={()=>{setAudio(true);setMini(false);setDocked(false)}}>Audio fixture</button><p>Playback continues while the player changes shape.</p><div id="away" style={{height:80}}>Outside player</div></div><div style={{margin:'0 auto',width:800}}><PlayerHost player={player} mini={mini} docked={docked} fullscreen={false} theater={false} blocked={false} hasPrevious={true} hasNext={true} focusSignal={0} onAction={(action,value)=>window.__fixture.actions.push({action,value})} onMode={mode=>setAudio(mode==='audio')} onPrevious={()=>{}} onNext={()=>{}} onFullscreen={()=>{}} onTheater={()=>{}} onExpand={()=>{setMini(false);setDocked(false)}} onDock={()=>setDocked(true)} onUndock={()=>setDocked(false)} onClose={()=>{}} onRetry={()=>{}}/></div></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const server = await createServer({ root, server: {host:'127.0.0.1',port:4181,strictPort:true}, plugins:[{
 name:'player-layout-fixture',
 configureServer(vite){vite.middlewares.use((request,response,next)=>{if(request.url==='/__player-layout'){response.setHeader('Content-Type','text/html');void vite.transformIndexHtml('/__player-layout','<!doctype html><html data-theme="dark"><head><title>Player layout fixture</title></head><body><div id="root"></div><script type="module" src="/__player-layout-fixture.tsx"></script></body></html>').then(html=>response.end(html));}else next();});},
 resolveId(id){if(id==='/__player-layout-fixture.tsx')return id;},load(id){if(id==='/__player-layout-fixture.tsx')return fixture;}
}]});
await mkdir(output,{recursive:true});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:920},reducedMotion:'reduce'});
 page.on('pageerror',error=>console.error('PAGE',error.message)); page.on('console',msg=>{if(msg.type()==='error')console.error('CONSOLE',msg.text());});
 page.setDefaultTimeout(30000);
 await page.addInitScript(()=>{window.__fixture={actions:[],bounds:[]};window.__TAURI_INTERNALS__={invoke:async(command,args)=>{if(command==='player_bounds')window.__fixture.bounds.push(args.bounds);return null;}};});
 await page.goto('http://127.0.0.1:4181/__player-layout',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.__fixture.bounds.some(bounds=>bounds.visible));
 await page.getByRole('button',{name:'Move player to bottom bar'}).click();
 await page.getByRole('region',{name:'Bottom player'}).waitFor();
 const box=await page.locator('.bottom-player').boundingBox();
 check('dock spans window bottom',box.x===0&&box.width===1440&&box.y+box.height===920,box);
 await page.waitForFunction(()=>window.__fixture.bounds.at(-1)?.visible===false);
 check('docking hides native video rectangle',await page.locator('.player-surface').isHidden()&&await page.evaluate(()=>window.__fixture.bounds.at(-1).visible===false));
 check('docking does not issue playback actions',(await page.evaluate(()=>window.__fixture.actions)).length===0);
 await page.getByRole('button',{name:'Pause (Space)'}).hover();
 check('dock primary button stays legible on hover',await page.locator('.bottom-play-button').evaluate(el=>(()=>{const css=getComputedStyle(el); const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];};const a=luminance(css.backgroundColor),b=luminance(css.color);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;})()));
 await page.getByRole('button',{name:'Pause (Space)'}).click();
 check('dock pause operates existing source',(await page.evaluate(()=>window.__fixture.actions.at(-1))).action==='toggle');
 await page.getByRole('slider',{name:'Playback position'}).fill('60');
 check('dock seek targets current player',await page.evaluate(()=>window.__fixture.actions.some(action=>action.action==='seek'&&action.value===60)));
 await page.screenshot({path:path.join(output,'v013-bottom-player-dark.png')});
 await page.getByRole('button',{name:'Restore floating mini player'}).click();
 await page.waitForFunction(()=>window.__fixture.bounds.at(-1)?.visible===true);
 check('restore returns floating player',await page.locator('.mini-player:not(.bottom-player)').isVisible()&&await page.locator('.player-surface').isVisible());
 await page.locator('#audio').click();
 const stage=page.locator('.player-surface'), controls=page.locator('.audio-overlay-controls');
 await page.locator('#away').hover();
 check('audio controls hidden outside stage',await controls.evaluate(el=>getComputedStyle(el).visibility==='hidden'&&el.inert));
 await stage.hover();
 check('audio controls appear on stage hover',await controls.evaluate(el=>getComputedStyle(el).visibility==='visible'&&!el.inert));
 await page.getByRole('button',{name:'Playback settings'}).click();
 const menu=page.getByRole('menu',{name:'Playback settings'});
 check('settings has translucent glass',await menu.evaluate(el=>getComputedStyle(el).backdropFilter.includes('blur')&&getComputedStyle(el).backgroundImage.includes('rgba')));
 await page.screenshot({path:path.join(output,'v013-glass-player-settings.png')});
 await page.locator('#away').hover();
 check('leaving screen dismisses audio controls and menu',await controls.evaluate(el=>getComputedStyle(el).visibility==='hidden')&&await menu.count()===0);
 await page.keyboard.press('Tab');
 await page.getByRole('button',{name:'Pause audio'}).focus();
 check('keyboard focus reveals audio controls',await controls.evaluate(el=>getComputedStyle(el).visibility==='visible'&&!el.inert));
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 await page.screenshot({path:path.join(output,'v013-audio-player-light.png')});
 await writeFile(path.join(output,'v013-player-layout-results.json'),JSON.stringify({passed:true,results},null,2));
 console.log(JSON.stringify({passed:true,checks:results.length}));
} catch(error){await writeFile(path.join(output,'v013-player-layout-results.json'),JSON.stringify({passed:false,error:String(error),results},null,2));throw error;}
finally{await browser.close();await server.close();}

