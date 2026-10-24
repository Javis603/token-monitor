'use strict';
/* global document */
const nodes = new Map();
function context({ snapshot, theme }) {
  for (const [key,value] of Object.entries(theme.colors)) document.documentElement.style.setProperty(`--${key}`,value);
  document.documentElement.dataset.reduced=String(theme.reducedMotion);
  document.body.style.fontFamily=theme.font;
  document.querySelector('h1').textContent={model:'Models',tool:'Tools',device:'Devices'}[snapshot.target]||'Usage';
  document.getElementById('summary').textContent=`${snapshot.period} · ${snapshot.totalTokens.toLocaleString()} tokens`;
  const rows=document.getElementById('rows');const max=Math.max(1,...snapshot.rows.map(row=>row.tokens));const keys=new Set();
  for(const row of snapshot.rows.slice(0,12)){
    keys.add(row.key);let node=nodes.get(row.key);
    if(!node){node=document.createElement('article');const label=document.createElement('div');label.className='label';label.append(document.createElement('span'),document.createElement('strong'));const track=document.createElement('div');track.className='track';const bar=document.createElement('div');bar.className='bar';bar.style.transform='scaleX(0)';track.append(bar);node.append(label,track);rows.append(node);nodes.set(row.key,node);}
    node.querySelector('span').textContent=row.label;node.querySelector('strong').textContent=row.tokens.toLocaleString();
    requestAnimationFrame(()=>{node.querySelector('.bar').style.transform=`scaleX(${row.tokens/max})`;});
  }
  for(const [key,node] of nodes)if(!keys.has(key)){node.remove();nodes.delete(key);}
}
function data(readings){const value=readings['sys.details']?.value;if(!value)return;const cpu=value.cpu.value;document.getElementById('system').textContent=cpu?`CPU ${cpu.percent.toFixed(0)}% · RAM ${value.memory.value.percent}%`:'CPU baseline pending';const host=document.getElementById('cores');const values=cpu?.perCore||[];while(host.children.length<values.length)host.append(document.createElement('i'));while(host.children.length>values.length)host.lastChild.remove();values.forEach((v,i)=>{host.children[i].style.transform=`scaleY(${Math.max(.04,(v||0)/100)})`;});}
tm.onContext(context);tm.context().then(context);tm.onData(data);tm.subscribe(['sys.details']).then(data);
document.getElementById('restore').onclick=()=>tm.restoreOriginal();
const note=document.getElementById('note');tm.storage.get('note').then(value=>{note.value=typeof value==='string'?value:''});note.addEventListener('change',()=>tm.storage.set('note',note.value));
