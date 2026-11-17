-- TubeDesk native controls. Only application-owned actions cross the IPC bridge.
-- No file access, subprocess execution, remote code, URLs or cookies are used here.
local mp=require("mp")
local utils=require("mp.utils")
local osd=mp.create_osd_overlay("ass-events")
local context={loadId=0,mode="video",quality=0,qualities={},hasPrevious=false,hasNext=false,mini=false,theater=false,fullscreen=false,title=""}
local state={time=0,duration=0,pause=false,volume=80,mute=false,speed=1,buffering=false}
local mouse={x=-1,y=-1,hover=false}
local width,height=1280,720
local visible_until=0
local hitboxes={}
local menu=nil
local menu_page=0
local drag=nil
local pointer_down=nil
local click_timer=nil
local suppress_until=0
local dirty=true
local function clamp(v,a,b)return math.max(a,math.min(b,v))end
local function text(value)
 return tostring(value or ""):gsub("[{}\\]",""):gsub("[\r\n]"," ")
end
local function stamp(value)
 value=math.max(0,math.floor(tonumber(value)or 0))
 if value>=3600 then return string.format("%d:%02d:%02d",math.floor(value/3600),math.floor(value/60)%60,value%60)end
 return string.format("%d:%02d",math.floor(value/60),value%60)
end
local function request(action,value)
 if not context.loadId or context.loadId==0 then return end
 mp.commandv("script-message","tubedesk-control",tostring(context.loadId),action,tostring(value or ""))
 visible_until=mp.get_time()+2.5
 dirty=true
end
local function inside(box,x,y)return x>=box.x and x<=box.x+box.w and y>=box.y and y<=box.y+box.h end
local function find_hit(x,y)
 for index=#hitboxes,1,-1 do if inside(hitboxes[index],x,y)then return hitboxes[index]end end
end
local chunks={}
local function append(value)chunks[#chunks+1]=value end
local function polygon(points,color,alpha)
 local path={}
 for index,point in ipairs(points)do path[#path+1]=(index==1 and "m "or"l ")..string.format("%.2f %.2f ",point[1],point[2])end
 append(string.format("{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a&H%02X&\\p1}%s{\\p0}\n",color or"FFFFFF",alpha or 0,table.concat(path)))
end
local function rect(x,y,w,h,color,alpha)
 polygon({{x,y},{x+w,y},{x+w,y+h},{x,y+h}},color,alpha)
end
local function gradient(top,bottom,opacity_top,opacity_bottom)
 -- libass has no native linear-gradient fill. Clip an identical full-width
 -- shape to physical pixel rows instead of abutting antialiased polygons.
 -- One alpha step per pixel and smoothstep endpoints avoid both broad bands
 -- and thin bright seams at fractional DPI scales.
 top=math.max(0,math.floor(top));bottom=math.min(height,math.ceil(bottom))
 local span=bottom-top
 if span<1 then return end
 for y=top,bottom-1 do
  local t=(y-top+.5)/span;t=t*t*(3-2*t)
  local opacity=opacity_top+(opacity_bottom-opacity_top)*t
  local alpha=clamp(math.floor(255*(1-opacity)+.5),0,255)
  append(string.format("{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H000000&\\1a&H%02X&\\clip(0,%d,%d,%d)\\p1}m 0 0 l %d 0 l %d %d l 0 %d{\\p0}\n",alpha,y,width,y+1,width,width,height,height))
 end
end
local function rounded_rect(x,y,w,h,r,color,alpha)
 local points={}
 r=math.min(r,w/2,h/2)
 for _,corner in ipairs({{x+w-r,y+r,-math.pi/2},{x+w-r,y+h-r,0},{x+r,y+h-r,math.pi/2},{x+r,y+r,math.pi}})do
  for step=0,6 do local angle=corner[3]+step*math.pi/12;points[#points+1]={corner[1]+math.cos(angle)*r,corner[2]+math.sin(angle)*r}end
 end
 polygon(points,color,alpha)
end
local function circle(x,y,r,color,alpha)
 local points={}
 for step=0,24 do local angle=math.pi*2*step/24;points[#points+1]={x+math.cos(angle)*r,y+math.sin(angle)*r}end
 polygon(points,color,alpha)
end
local function label(x,y,value,size,color,alpha,anchor)
 append(string.format("{\\an%d\\pos(%.2f,%.2f)\\fnSegoe UI\\fs%.2f\\bord0\\shad0\\1c&H%s&\\1a&H%02X&}%s\n",anchor or 4,x,y,size,color or"FFFFFF",alpha or 0,text(value)))
end
local function line(x1,y1,x2,y2,thickness,color,alpha)
 local dx,dy=x2-x1,y2-y1
 local length=math.sqrt(dx*dx+dy*dy)
 if length==0 then return end
 local nx,ny=-dy/length*thickness/2,dx/length*thickness/2
 polygon({{x1+nx,y1+ny},{x2+nx,y2+ny},{x2-nx,y2-ny},{x1-nx,y1-ny}},color,alpha)
end
local function shape(points,x,y,size,color,alpha)
 local transformed={}
 for _,point in ipairs(points)do transformed[#transformed+1]={x+point[1]*size/24,y+point[2]*size/24}end
 polygon(transformed,color,alpha)
end
local function icon(name,x,y,size,alpha)
 local s=size/24
 if name=="play"then shape({{7,4},{21,12},{7,20}},x,y,size,"FFFFFF",alpha)
 elseif name=="pause"then rect(x+6*s,y+4*s,4*s,16*s,"FFFFFF",alpha);rect(x+14*s,y+4*s,4*s,16*s,"FFFFFF",alpha)
 elseif name=="next"then shape({{4,5},{16,12},{4,19}},x,y,size,"FFFFFF",alpha);rect(x+17*s,y+5*s,3*s,14*s,"FFFFFF",alpha)
 elseif name=="previous"then shape({{20,5},{8,12},{20,19}},x,y,size,"FFFFFF",alpha);rect(x+4*s,y+5*s,3*s,14*s,"FFFFFF",alpha)
 elseif name=="volume"or name=="muted"then
  shape({{3,9},{7,9},{13,4},{13,20},{7,15},{3,15}},x,y,size,"FFFFFF",alpha)
  if name=="muted"then line(x+17*s,y+8*s,x+23*s,y+16*s,2*s,"FFFFFF",alpha);line(x+23*s,y+8*s,x+17*s,y+16*s,2*s,"FFFFFF",alpha)
  else line(x+17*s,y+7*s,x+20*s,y+10*s,2*s,"FFFFFF",alpha);line(x+20*s,y+10*s,x+20*s,y+14*s,2*s,"FFFFFF",alpha);line(x+20*s,y+14*s,x+17*s,y+17*s,2*s,"FFFFFF",alpha)end
 elseif name=="settings"then
  for step=0,7 do local angle=step*math.pi/4;local cx=x+12*s+math.cos(angle)*8*s;local cy=y+12*s+math.sin(angle)*8*s;circle(cx,cy,3*s,"FFFFFF",alpha)end
  circle(x+12*s,y+12*s,8*s,"FFFFFF",alpha);circle(x+12*s,y+12*s,3.4*s,"181818",alpha)
 elseif name=="theater"then rect(x+2*s,y+5*s,20*s,14*s,"FFFFFF",alpha);rect(x+4*s,y+7*s,16*s,10*s,"181818",alpha)
 elseif name=="fullscreen"then
  for _,corner in ipairs({{3,3,1,1},{21,3,-1,1},{3,21,1,-1},{21,21,-1,-1}})do
   line(x+corner[1]*s,y+corner[2]*s,x+(corner[1]+corner[3]*6)*s,y+corner[2]*s,2.5*s,"FFFFFF",alpha)
   line(x+corner[1]*s,y+corner[2]*s,x+corner[1]*s,y+(corner[2]+corner[4]*6)*s,2.5*s,"FFFFFF",alpha)
  end
 elseif name=="headphones"then
  line(x+4*s,y+10*s,x+4*s,y+18*s,3*s,"FFFFFF",alpha);line(x+20*s,y+10*s,x+20*s,y+18*s,3*s,"FFFFFF",alpha)
  local last=nil
  for step=0,12 do local angle=math.pi+step*math.pi/12;local point={x+12*s+math.cos(angle)*8*s,y+11*s+math.sin(angle)*8*s};if last then line(last[1],last[2],point[1],point[2],2.5*s,"FFFFFF",alpha)end;last=point end
  rect(x+3*s,y+13*s,5*s,8*s,"FFFFFF",alpha);rect(x+16*s,y+13*s,5*s,8*s,"FFFFFF",alpha)
 elseif name=="back"then line(x+15*s,y+5*s,x+8*s,y+12*s,2*s,"FFFFFF",alpha);line(x+8*s,y+12*s,x+15*s,y+19*s,2*s,"FFFFFF",alpha)
 elseif name=="chevron"then line(x+9*s,y+5*s,x+16*s,y+12*s,2*s,"FFFFFF",alpha);line(x+16*s,y+12*s,x+9*s,y+19*s,2*s,"FFFFFF",alpha)
 elseif name=="gauge"then
  local last=nil
  for step=0,18 do local angle=math.pi*.8+step*math.pi*1.4/18;local point={x+12*s+math.cos(angle)*9*s,y+13*s+math.sin(angle)*9*s};if last then line(last[1],last[2],point[1],point[2],1.8*s,"FFFFFF",alpha)end;last=point end
  line(x+12*s,y+13*s,x+17*s,y+7*s,2*s,"FFFFFF",alpha);circle(x+12*s,y+13*s,1.7*s,"FFFFFF",alpha)
 elseif name=="sliders"then
  for _,row in ipairs({{5,8},{12,16},{19,9}})do
   line(x+3*s,y+row[1]*s,x+21*s,y+row[1]*s,1.6*s,"FFFFFF",alpha)
   rect(x+(row[2]-2)*s,y+(row[1]-3)*s,4*s,6*s,"FFFFFF",alpha)
  end
 elseif name=="video"then
  line(x+3*s,y+5*s,x+17*s,y+5*s,1.7*s,"FFFFFF",alpha);line(x+17*s,y+5*s,x+17*s,y+19*s,1.7*s,"FFFFFF",alpha);line(x+17*s,y+19*s,x+3*s,y+19*s,1.7*s,"FFFFFF",alpha);line(x+3*s,y+19*s,x+3*s,y+5*s,1.7*s,"FFFFFF",alpha)
  shape({{17,9},{23,5},{23,19},{17,15}},x,y,size,"FFFFFF",alpha)
 elseif name=="check"then line(x+5*s,y+12*s,x+10*s,y+17*s,2*s,"FFFFFF",alpha);line(x+10*s,y+17*s,x+20*s,y+6*s,2*s,"FFFFFF",alpha)
 end
end
local function add_hit(x,y,w,h,action,value,enabled)
 local box={x=x,y=y,w=w,h=h,action=action,value=value,enabled=enabled~=false}
 hitboxes[#hitboxes+1]=box
 return box
end
local function button(x,y,size,name,action,value,enabled)
 local box=add_hit(x,y,size,size,action,value,enabled)
 local hovered=mouse.hover and inside(box,mouse.x,mouse.y)
 if hovered and enabled~=false then circle(x+size/2,y+size/2,size/2-2,"FFFFFF",220)end
 icon(name,x+size*.2,y+size*.2,size*.6,enabled==false and 150 or 0)
end
local function menu_rows()
 if menu=="mode"then
  return{{title="Video",icon="video",action="mode",value="video",selected=context.mode~="audio"},{title="Audio only",icon="headphones",action="mode",value="audio",selected=context.mode=="audio"}},"Playback mode"
 elseif menu=="speed"then
  local rows={}
  for _,speed in ipairs({0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3})do rows[#rows+1]={title=speed==1 and"Normal"or tostring(speed).."x",action="speed",value=speed,selected=math.abs(state.speed-speed)<0.01}end
  return rows,"Playback speed"
 elseif menu=="quality"then
  local rows={}
  local qualities={}
  for _,quality in ipairs(context.qualities or{})do qualities[#qualities+1]=quality end
  table.sort(qualities,function(a,b)return a>b end)
  for _,quality in ipairs(qualities)do rows[#rows+1]={title=tostring(quality).."p",detail=quality>=1080 and"HD"or nil,action="quality",value=quality,selected=context.quality==quality}end
  return rows,"Quality"
 end
 return{
  {title="Playback mode",icon="headphones",detail=context.mode=="audio"and"Audio only"or"Video",submenu="mode"},
  {title="Playback speed",icon="gauge",detail=state.speed==1 and"Normal"or tostring(state.speed).."x",submenu="speed"},
  {title="Quality",icon="sliders",detail=context.mode=="audio"and"Audio only"or tostring(context.quality or 0).."p",submenu="quality",disabled=context.mode=="audio"or#(context.qualities or{})==0}
 },"Settings"
end
local function draw_menu(scale,bottom)
 local rows,title=menu_rows()
 local root=menu=="settings"
 local rowh=44*scale
 local padding=7*scale
 local header=root and 0 or rowh
 local available=math.max(1,math.floor((bottom-16*scale-2*padding-header)/rowh))
 if #rows>available then available=math.max(1,available-1)end
 local count=math.min(#rows,available)
 local pages=math.max(1,math.ceil(#rows/available))
 if menu_page>=pages then menu_page=0 end
 local start=menu_page*available+1
 local has_more=pages>1
 local panelw=math.min(width-24*scale,305*scale)
 local panelh=header+(count+(has_more and 1 or 0))*rowh+2*padding
 local x,y=width-panelw-12*scale,math.max(8,bottom-panelh)
 -- ASS overlays cannot sample/blur the video. A translucent tinted panel,
 -- soft shadow and fine highlight retain the glass appearance over any frame.
 rounded_rect(x-3*scale,y+3*scale,panelw+6*scale,panelh+4*scale,14*scale,"000000",205)
 rounded_rect(x,y,panelw,panelh,12*scale,"FFFFFF",214)
 rounded_rect(x+scale,y+scale,panelw-2*scale,panelh-2*scale,11*scale,"242428",58)
 add_hit(x,y,panelw,panelh,"menu-background",nil)
 if not root then
  add_hit(x,y+padding,panelw,rowh,"menu","settings")
  icon("back",x+15*scale,y+padding+(rowh-18*scale)/2,18*scale)
  label(x+45*scale,y+padding+rowh/2,title,14*scale)
  rect(x+scale,y+padding+rowh,panelw-2*scale,1,"FFFFFF",223)
 end
 for row=1,count do
  local item=rows[start+row-1]
  if item then
   local ry=y+padding+header+(row-1)*rowh
   local box=add_hit(x,ry,panelw,rowh,item.submenu and"menu"or item.action,item.submenu or item.value,not item.disabled)
   local alpha=item.disabled and 145 or 0
   if not item.disabled and mouse.hover and inside(box,mouse.x,mouse.y)then rect(x+scale,ry,panelw-2*scale,rowh,"FFFFFF",231)end
   if root then
    icon(item.icon,x+15*scale,ry+(rowh-21*scale)/2,21*scale,alpha)
    label(x+48*scale,ry+rowh/2,item.title,13*scale,"FFFFFF",alpha)
    icon("chevron",x+panelw-33*scale,ry+(rowh-18*scale)/2,18*scale,alpha)
   else
    if item.selected then icon("check",x+15*scale,ry+(rowh-17*scale)/2,17*scale)end
    if item.icon then icon(item.icon,x+44*scale,ry+(rowh-18*scale)/2,18*scale)end
    label(x+(item.icon and 74 or 45)*scale,ry+rowh/2,item.title,13*scale,"FFFFFF",alpha)
   end
   if item.detail then label(x+panelw-(root and 47 or 15)*scale,ry+rowh/2,item.detail,12*scale,"F1F1F1",alpha,6)end
  end
 end
 if has_more then local ry=y+padding+header+count*rowh;add_hit(x,ry,panelw,rowh,"menu-page",nil);label(x+45*scale,ry+rowh/2,"More options",13*scale,"DADADA")end
end
local function render()
 local dims=mp.get_property_native("osd-dimensions")
 if not dims or not dims.w or dims.w<1 or dims.h<1 then return end
 width,height=dims.w,dims.h
 local now=mp.get_time()
 local pointer_inside=mouse.hover and mouse.x>=0 and mouse.y>=0 and mouse.x<width and mouse.y<height
 -- Pause/buffering/menu state must never leave controls behind outside the
 -- native video rectangle. Keyboard shortcuts still work without the overlay.
 if not pointer_inside then menu=nil;menu_page=0;drag=nil;pointer_down=nil end
 local visible=pointer_inside and(menu or drag or state.pause or state.buffering or now<visible_until)
 if context.mode=="audio"or not context.loadId or context.loadId==0 then visible=false end
 chunks={};hitboxes={}
 if visible then
  local scale=clamp(width/1000,1.2,1.5)
  if context.mini then scale=clamp(width/620,.65,.9)end
  local controls=56*scale
  local progress_y=height-controls-10*scale
  gradient(height-130*scale,height,0,.76)
  if not context.mini then
   gradient(0,84*scale,.68,0)
   local title=context.title or""
   if #title>110 then title=title:sub(1,107).."..."end
   label(18*scale,25*scale,title,18*scale)
  end
  local startx,endx=12*scale,width-12*scale
  local duration=math.max(0,state.duration)
  local position=drag and drag.kind=="seek"and drag.value or state.time
  local ratio=duration>0 and clamp(position/duration,0,1)or 0
  rect(startx,progress_y,endx-startx,3*scale,"FFFFFF",175)
  rect(startx,progress_y,(endx-startx)*ratio,3*scale,"3333FF",0)
  local seek=add_hit(startx,progress_y-8*scale,endx-startx,19*scale,"seek-slider",nil,duration>0)
  if drag and drag.kind=="seek"or(mouse.hover and inside(seek,mouse.x,mouse.y))then circle(startx+(endx-startx)*ratio,progress_y+1.5*scale,6*scale,"3333FF")end
  local y=height-controls+5*scale
  local size=42*scale
  local x=6*scale
  if not context.mini then button(x,y,size,"previous","previous",nil,context.hasPrevious);x=x+size end
  local paused_intent=context.pausedIntent
  if paused_intent==nil then paused_intent=state.pause end
  button(x,y,size,paused_intent and"play"or"pause","toggle");x=x+size
  button(x,y,size,"next","next",nil,context.hasNext);x=x+size
  if not context.mini then
   button(x,y,size,state.mute and"muted"or"volume","mute",state.mute and 0 or 1);x=x+size
   local vw=60*scale
   rect(x,y+size/2-1*scale,vw,3*scale,"FFFFFF",150)
   local volume=drag and drag.kind=="volume"and drag.value or(state.mute and 0 or state.volume)
   rect(x,y+size/2-1*scale,vw*clamp(volume/100,0,1),3*scale,"FFFFFF",0);circle(x+vw*clamp(volume/100,0,1),y+size/2,4*scale,"FFFFFF")
   add_hit(x-5*scale,y,vw+10*scale,size,"volume-slider");x=x+vw+18*scale
   label(x,y+size/2,stamp(position).." / "..stamp(duration),13*scale)
  end
  local right=width-size-5*scale
  button(right,y,size,"fullscreen","fullscreen");right=right-size
  if not context.mini then button(right,y,size,"theater","theater");right=right-size end
  button(right,y,size,"settings",context.mini and"focus-controls"or"menu","settings");right=right-size
  if not context.mini then button(right,y,size,"headphones","mode",context.mode=="audio"and"video"or"audio")end
  if drag and drag.kind=="seek"then label(clamp(mouse.x,40*scale,width-40*scale),progress_y-18*scale,stamp(drag.value),14*scale,"FFFFFF",0,2)end
  if menu then draw_menu(scale,progress_y-12*scale)end
 end
 if state.buffering and not state.pause and context.mode=="video"then
  circle(width/2,height/2,22,"000000",100)
  local angle=(now*3)%(math.pi*2)
  for i=0,7 do local a=angle+i*.58;circle(width/2+math.cos(a)*14,height/2+math.sin(a)*14,2.8,"FFFFFF",i*22)end
 end
 osd.res_x=width;osd.res_y=height;osd.data=table.concat(chunks);osd:update()
 dirty=false
end
local function activate(box)
 if not box then return false end
 if box.enabled==false then return true end
 if box.action=="menu"then menu=box.value;menu_page=0;dirty=true
 elseif box.action=="menu-page"then menu_page=menu_page+1;dirty=true
 elseif box.action=="menu-background"then return true
 elseif box.action=="seek-slider"or box.action=="volume-slider"then return true
 else request(box.action,box.value);menu=nil end
 return true
end
local function drag_value()
 if not drag then return end
 local ratio=clamp((mouse.x-drag.x)/drag.w,0,1)
 drag.value=ratio*(drag.kind=="seek"and state.duration or 100)
 dirty=true
end
mp.add_forced_key_binding("MBTN_LEFT","tubedesk-pointer",function(event)
 if event.canceled then drag=nil;pointer_down=nil;dirty=true;return end
 if mp.get_time()<suppress_until then return end
 visible_until=mp.get_time()+2.5
 local box=find_hit(mouse.x,mouse.y)
 if event.event=="down"then
  if not mouse.hover then return end
  pointer_down={x=mouse.x,y=mouse.y,loadId=context.loadId,action=box and box.action,value=box and box.value}
  if box and box.enabled~=false and(box.action=="seek-slider"or box.action=="volume-slider")then
   drag={kind=box.action=="seek-slider"and"seek"or"volume",x=box.x,w=box.w,value=0};drag_value()
  end
 elseif event.event=="up"then
  local press=pointer_down;pointer_down=nil
  if not press or press.loadId~=context.loadId or not mouse.hover then drag=nil;return end
  if drag then local action=drag.kind=="seek"and"seek"or"volume";local value=drag.value;drag=nil;request(action,value)
  else
   local action=box and box.action;local value=box and box.value
   local threshold=math.max(6,width/1000*6)
   if action~=press.action or value~=press.value or math.abs(mouse.x-press.x)>threshold or math.abs(mouse.y-press.y)>threshold then return end
   if not activate(box)then
   if menu then menu=nil;dirty=true
   else
    if click_timer then click_timer:kill()end
    click_timer=mp.add_timeout(.28,function()click_timer=nil;request("toggle")end)
   end
   end
  end
 elseif event.event=="canceled"then drag=nil;pointer_down=nil end
 dirty=true
end,{complex=true})
mp.add_forced_key_binding("MBTN_LEFT_DBL","tubedesk-double-click",function()
 if find_hit(mouse.x,mouse.y) then return end
 if click_timer then click_timer:kill();click_timer=nil end
 drag=nil;pointer_down=nil;suppress_until=mp.get_time()+.3;menu=nil;request("fullscreen")
end)
local keys={SPACE="toggle",k="toggle",f="fullscreen",m="mute",["Ctrl+k"]="focus-controls"}
for key,action in pairs(keys)do mp.add_forced_key_binding(key,"tubedesk-"..key,function()request(action)end)end
mp.add_forced_key_binding("ESC","tubedesk-escape",function()if menu then menu=nil;dirty=true elseif context.fullscreen then request("fullscreen")else request("focus-controls")end end)
mp.add_forced_key_binding("RIGHT","tubedesk-forward",function()request("seek",math.min(state.duration,state.time+10))end,{repeatable=true})
mp.add_forced_key_binding("LEFT","tubedesk-back",function()request("seek",math.max(0,state.time-10))end,{repeatable=true})
mp.add_forced_key_binding("l","tubedesk-forward-l",function()request("seek",math.min(state.duration,state.time+10))end)
mp.add_forced_key_binding("j","tubedesk-back-j",function()request("seek",math.max(0,state.time-10))end)
mp.observe_property("mouse-pos","native",function(_,value)
 value=value or{x=-1,y=-1,hover=false}
 local moved=mouse.x~=value.x or mouse.y~=value.y or(not mouse.hover and value.hover~=false)
 mouse.x=value.x or-1;mouse.y=value.y or-1;mouse.hover=value.hover~=false
 if not mouse.hover or mouse.x<0 or mouse.y<0 or mouse.x>=width or mouse.y>=height then
  pointer_down=nil;drag=nil;menu=nil;menu_page=0;visible_until=0
 end
 if moved then visible_until=mp.get_time()+2.5 end
 if drag then drag_value()end
 dirty=true
end)
local observed={["time-pos"]={"time","number"},duration={"duration","number"},pause={"pause","bool"},volume={"volume","number"},mute={"mute","bool"},speed={"speed","number"},["paused-for-cache"]={"buffering","bool"}}
for property,definition in pairs(observed)do
 mp.observe_property(property,definition[2],function(_,value)if value~=nil then state[definition[1]]=value;dirty=true end end)
end
mp.register_script_message("context",function(raw)
 local parsed=utils.parse_json(raw)
 if type(parsed)~="table"then return end
 local changed=parsed.loadId~=context.loadId
 if changed then
  if click_timer then click_timer:kill();click_timer=nil end
  drag=nil;pointer_down=nil;suppress_until=0
 end
 context=parsed
 context.qualities=context.qualities or{}
 if changed then menu=nil end
 visible_until=mp.get_time()+2.5;dirty=true
end)
mp.register_event("file-loaded",function()visible_until=mp.get_time()+2.5;dirty=true end)
mp.register_event("end-file",function()menu=nil;drag=nil;pointer_down=nil;dirty=true end)
mp.add_periodic_timer(.075,function()
 if dirty or state.buffering or menu or drag or mouse.hover then render()end
end)

