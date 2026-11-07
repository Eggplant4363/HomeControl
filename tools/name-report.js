/* 只读：打印真实 HA 里每个房间的卡片名称，用来诊断「名称显示不对」 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'ha.json'),'utf8'));
const wsUrl=String(cfg.url).replace(/\/$/,'')+'/api/websocket';
const sandbox={window:{},WebSocket:global.WebSocket,Promise,setTimeout,clearTimeout,setInterval,clearInterval,console,JSON,Math,Date,String,Number,Object,Array,parseInt,parseFloat,isNaN};
sandbox.global=sandbox; vm.createContext(sandbox);
for(const f of ['panel/js/backend.js','panel/js/layout.js']) vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),sandbox,{filename:f});
const win=sandbox.window;
const be=new win.HABackend({url:wsUrl,token:cfg.token});
let states=null; be.onStates(s=>states=s); be.start();
(async()=>{
  const t0=Date.now(); while(!states && Date.now()-t0<15000) await new Promise(r=>setTimeout(r,200));
  if(!states){ console.log('FAIL no states'); process.exit(1); }
  const areas=await req('config/area_registry/list');
  const devices=await req('config/device_registry/list');
  const entities=await req('config/entity_registry/list');
  const out=win.Layout.build(states,areas,devices,entities);
  const devById={}; devices.forEach(d=>devById[d.id]=d);
  const entById={}; entities.forEach(e=>entById[e.entity_id]=e);
  for(const room of out.rooms){
    console.log('\n== '+room.name+' ('+room.tiles.length+') ==');
    for(const t of room.tiles){
      const a=(states[t.entity]&&states[t.entity].attributes)||{};
      const e=entById[t.entity]||{}, d=devById[e.device_id]||{};
      console.log([
        t.type.padEnd(8),
        t.entity.slice(0,44).padEnd(44),
        '| name='+String(t.name).slice(0,34).padEnd(34),
        '| fn='+String(a.friendly_name||'-').slice(0,30).padEnd(30),
        '| ent='+String(e.name||e.original_name||'-').slice(0,18).padEnd(18),
        '| dev='+String(d.name||d.name_by_user||'-').slice(0,16)
      ].join(' '));
    }
  }
  process.exit(0);
  async function req(cmd){
    return await be.requestCmd({id:Math.floor(Math.random()*1e6),type:cmd});
  }
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
