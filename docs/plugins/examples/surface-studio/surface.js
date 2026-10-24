/* global document */
'use strict';
function context({theme,variant}){document.documentElement.style.colorScheme=theme.dark?'dark':'light';for(const [key,value] of Object.entries(theme.colors))document.documentElement.style.setProperty(`--${key}`,value);document.body.style.fontFamily=theme.font;document.documentElement.dataset.variant=variant;document.documentElement.dataset.reduced=String(theme.reducedMotion);}
function data(values){const percent=values['sys.cpu']?.value;document.getElementById('value').textContent=Number.isFinite(percent)?`${Math.round(percent)}%`:'—';}
tm.onContext(context);tm.context().then(context);tm.onData(data);tm.subscribe(['sys.cpu']).then(data);
const note=document.getElementById('note');tm.storage.get('note').then(value=>{note.value=typeof value==='string'?value:''});note.addEventListener('change',()=>tm.storage.set('note',note.value));
