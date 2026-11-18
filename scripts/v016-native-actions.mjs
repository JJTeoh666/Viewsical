import assert from 'node:assert/strict';

export async function verify({page, overlay, ipc, invoke, get, command, until, delay, pass}) {
  const state = () => ipc('player_state');
  const bodyFocus = target => target.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();});
  const scoped = async (target, action, value) => invoke(target, 'player_overlay_action', {loadId:(await state()).loadId, action, value:value??null, mode:null});
  const volume = async value => {await ipc('player_action',{action:'volume',value}); await until(async()=>(await state()).volume===value,'volume');};
  await overlay.keyboard.press('Escape');
  await bodyFocus(overlay);
  await ipc('player_action',{action:'pause'});
  await volume(37);
  await scoped(overlay,'adjust-volume',5); assert.equal((await state()).volume,42);
  await scoped(page,'adjust-volume',-5); assert.equal((await state()).volume,37);
  await Promise.all(Array.from({length:8},()=>scoped(overlay,'adjust-volume',5))); assert.equal((await state()).volume,77);
  await volume(98); await scoped(overlay,'adjust-volume',5); assert.equal((await state()).volume,100);
  await volume(2); await scoped(page,'adjust-volume',-5); assert.equal((await state()).volume,0);
  await ipc('player_action',{action:'mute',value:1}); await volume(37); await scoped(overlay,'adjust-volume',5);
  assert.equal((await state()).muted,true); assert.equal(await get('volume-gain'),-6);
  assert.equal((await ipc('bootstrap')).settings.volume,42);
  await ipc('player_action',{action:'mute',value:0});
  pass('serialized five-point adjustments preserve mute, normalization and saved user volume');

  await bodyFocus(overlay); await overlay.keyboard.press('ArrowUp');
  await until(async()=>(await state()).volume===47,'overlay key +5');
  await page.locator('#search').focus(); await page.keyboard.press('ArrowDown'); await delay(200); assert.equal((await state()).volume,47);
  await page.locator('.video-details h1').click(); await page.keyboard.press('ArrowDown');
  await until(async()=>(await state()).volume===42,'main key -5');
  await overlay.mouse.move(150,100); await overlay.getByRole('button',{name:'Playback settings',exact:true}).click();
  await overlay.keyboard.press('ArrowDown'); await delay(150); assert.equal((await state()).volume,42);
  await overlay.keyboard.press('Escape');
  pass('both native windows handle shortcuts once and preserve search/menu arrow navigation');

  const denied=await overlay.evaluate(async()=>{try{await window.__TAURI_INTERNALS__.invoke('bootstrap');return false;}catch{return true;}});
  assert(denied); const previous=(await state()).loadId;
  await ipc('player_action',{action:'pause'});
  await ipc('set_playback_mode',{mode:'audio'});
  await until(async()=>{const s=await state(); return s.playbackMode==='audio'&&s.status==='paused';},'paused audio switch');
  await until(async()=>!(await ipc('plugin:window|is_visible',{label:'player-overlay'})),'audio overlay hidden');
  await assert.rejects(()=>invoke(overlay,'player_overlay_action',{loadId:previous,action:'adjust-volume',value:5,mode:null}));
  assert.equal(await get('volume-gain'),-6); assert((await get('audio-out-params'))?.format);
  pass('audio-only preserves normalization and hides overlay; stale loads and unrelated commands rejected');

  await page.getByRole('button',{name:'Queue',exact:true}).click();
  await page.locator('.queue-video').last().click();
  await until(async()=>['playing','paused'].includes((await state()).status),'queued audio');
  await ipc('player_action',{action:'seek',value:117.5}); await ipc('player_action',{action:'resume'});
  await until(async()=>(await state()).status==='ended','last queue item EOF',15000);
  assert.equal(await page.locator('.queue-heading span').textContent(),'1 / 1');
  const endedLoad=(await state()).loadId;
  await page.locator('.audio-stage').hover();
  const seek=page.locator('.full-player .seek-slider'); const box=await seek.boundingBox(); assert(box);
  await page.mouse.move(box.x+box.width-5,box.y+box.height/2); await page.mouse.down();
  await page.mouse.move(box.x+box.width*.25,box.y+box.height/2,{steps:12}); await page.mouse.up();
  const resumed=await until(async()=>{const s=await state(); return s.status==='playing'&&s.position>26&&s.position<36?s:null;},'drag after final audio EOF');
  assert.equal(resumed.playbackMode,'audio'); assert(resumed.loadId>endedLoad); assert.equal(await get('volume-gain'),-6);
  assert.equal(await page.locator('.queue-heading span').textContent(),'1 / 1');
  pass('dragging after final queued audio EOF reopens at chosen position without altering queue or mode');
  await ipc('player_action',{action:'seek',value:118.5});
  await until(async()=>(await state()).status==='ended','second EOF',10000);
  await scoped(page,'toggle');
  await until(async()=>{const s=await state();return s.status==='playing'&&s.position<5;},'replay after EOF');
  await ipc('player_action',{action:'pause'});
  pass('replay after final audio EOF starts from zero');

  await page.getByRole('button',{name:'Switch to video',exact:true}).click();
  await until(async()=>(await state()).playbackMode==='video'&&(await state()).status==='paused','video return');
  await until(()=>ipc('plugin:window|is_visible',{label:'player-overlay'}),'reused overlay visible');
  await ipc('player_action',{action:'resume'});
  await overlay.mouse.move(150,100);
  const samples=await overlay.evaluate(async()=>{
    const values=[];const button=document.querySelector('button[aria-label="Playback settings"]');
    for(let i=0;i<35;i++) {button.click(); await new Promise(requestAnimationFrame);const t=performance.now();button.click();await new Promise(requestAnimationFrame);values.push(performance.now()-t);}
    return values.sort((a,b)=>a-b);
  });
  const p95=samples[Math.ceil(samples.length*.95)-1]; assert(p95<50,`native menu p95 ${p95}`);
  pass('native overlay menu response below 50ms p95',{p95Ms:p95,samples:samples.length});
  await overlay.keyboard.press('Escape'); await ipc('player_action',{action:'seek',value:10}); await ipc('player_action',{action:'resume'});
  const drops=async()=>({decoder:await get('decoder-frame-drop-count'),output:await get('frame-drop-count')});
  await overlay.dispatchEvent('.player-overlay-root','pointerleave'); const hidden=await drops(); await delay(10000); const afterHidden=await drops();
  await overlay.mouse.move(150,100); await overlay.getByRole('button',{name:'Playback settings',exact:true}).click(); const visible=await drops(); await delay(10000); const afterVisible=await drops();
  pass('1080p hidden and visible controls frame comparison',{hidden:{decoder:afterHidden.decoder-hidden.decoder,output:afterHidden.output-hidden.output},visible:{decoder:afterVisible.decoder-visible.decoder,output:afterVisible.output-visible.output}});
  await overlay.keyboard.press('Escape'); await ipc('player_action',{action:'pause'});

  const geometry=async()=>{
    const rect=await page.locator('.full-player .player-surface').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x*devicePixelRatio,y:r.y*devicePixelRatio,width:r.width*devicePixelRatio,height:r.height*devicePixelRatio,dpr:devicePixelRatio};});
    const main=await ipc('plugin:window|inner_position',{label:'main'}), position=await ipc('plugin:window|inner_position',{label:'player-overlay'}), size=await ipc('plugin:window|inner_size',{label:'player-overlay'});
    for(const [key,value] of Object.entries({x:position.x-main.x,y:position.y-main.y,width:size.width,height:size.height}))assert(Math.abs(value-rect[key])<=2,`${key}: ${value} != ${rect[key]}`);
    return rect;
  };
  const rect=await geometry();
  await scoped(overlay,'fullscreen'); await until(()=>ipc('plugin:window|is_fullscreen',{label:'main'}),'fullscreen'); await delay(400); await geometry();
  await scoped(overlay,'fullscreen'); await until(async()=>!(await ipc('plugin:window|is_fullscreen',{label:'main'})),'exit fullscreen'); await delay(400); await geometry();
  pass('native overlay alignment and fullscreen at actual Windows scaling',{scale:rect.dpr});
  const load=(await state()).loadId;
  await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.id='native-test-dialog';dialog.textContent='Overlay blocking test';document.body.append(dialog);dialog.showModal();});
  await until(async()=>!(await ipc('plugin:window|is_visible',{label:'player-overlay'})),'modal hides native overlay');
  await page.evaluate(()=>document.querySelector('#native-test-dialog').remove());
  await until(()=>ipc('plugin:window|is_visible',{label:'player-overlay'}),'modal release restores native overlay');
  assert.equal((await state()).loadId,load);
  pass('native modal stacking hides and restores controls without reloading playback');
  await page.getByRole('button',{name:'Home',exact:true}).first().click();
  await until(()=>page.locator('.mini-player').isVisible(),'mini player');
  await page.getByRole('button',{name:'Move player to bottom bar'}).click();
  await until(async()=>!(await ipc('plugin:window|is_visible',{label:'player-overlay'})),'docked hidden');
  await page.getByRole('button',{name:'Restore floating mini player'}).click();
  await until(()=>ipc('plugin:window|is_visible',{label:'player-overlay'}),'undocked shown');
  await page.getByRole('button',{name:'Expand player',exact:true}).click();
  await until(()=>page.locator('.full-player').isVisible(),'expanded');
  pass('one overlay follows mini player, hides for bottom docking and restores without source reload');
  await ipc('player_action',{action:'pause'});
}
