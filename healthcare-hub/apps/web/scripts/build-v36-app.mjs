// Builds public/v36/app.html: the v36 prototype exactly as designed, plus one small script that
// connects v36's shared-copy seam (window.claude.use('db')) to our API through the parent page.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../docs/design/healthcare-hub-uk-v36.html');
const out = resolve(here, '../public/v36/app.html');

const bridge = `<script>(function(){
if(parent===window){location.replace('/');return}
var B=null;function bridge(){try{B=B||parent.__hhV36||null}catch(e){}return B}
function waitB(){return new Promise(function(ok,no){var n=0;(function t(){if(bridge())return ok(B);if(++n>100)return no(new Error('no bridge'));setTimeout(t,50)})()})}
var ready=false,de=document.documentElement;
var cover=document.createElement('style');cover.textContent='body{visibility:hidden}';de.appendChild(cover);
function show(){ready=true;if(cover.parentNode)cover.parentNode.removeChild(cover)}
setTimeout(show,10000);
function snap(p){return B.get(p).then(function(r){return{exists:!!r.exists,data:function(){return r.data}}})}
var db={doc:function(p){return{
 get:function(){return snap(p).then(function(s){if(p==='demo/meta'&&!s.exists)ready=true;return s})},
 set:function(d){return ready?B.put(p,d):Promise.resolve()},
 onSnapshot:function(cb,err){var on=true,last=null;ready=true;var lk=function(){if(window.__hhLinkLoad)return window.__hhLinkLoad()};
  (function tick(){if(!on)return;snap(p).then(function(s){var v=s.exists?JSON.stringify(s.data()):'';if(v!==last){var first=last===null;last=v;cb(s);setTimeout(function(){var p=lk();if(first)Promise.resolve(p).then(show,show)},1500)}},function(e){if(err)err(e)}).then(function(){if(on)setTimeout(tick,3000)})})();
  return function(){on=false}}}}};
window.claude={use:function(k){return k==='db'?waitB().then(function(){return db}):Promise.reject(new Error('not available'))}};
var css='#shB{display:none!important}'+(bridge()&&B.viewAs?'':'.viewas{display:none!important}');
// Sign out: v36 has none; same button style as the bar's other buttons, after the person chip.
document.addEventListener('DOMContentLoaded',function(){waitB().then(function(){var me=document.querySelector('.me');if(!me||!B.signOut)return;
 var b=document.createElement('button');b.type='button';b.id='hhSignOut';b.className='ant-btn ant-btn-default ant-btn-color-default ant-btn-variant-outlined';
 b.textContent='Sign out';b.style.marginLeft='8px';b.onclick=function(){B.signOut()};me.parentNode.insertBefore(b,me.nextSibling)},function(){})});
var st=document.createElement('style');st.textContent=css;de.appendChild(st);
})();</script>`;

// Step 2: the link to the real tables. Two exact, checked insertions into v36's own script:
// a handle on v36's data and painting (after variantInit), and a call after every save().
const hook =
  'window.__HH={get S(){return S},get TODAY(){return TODAY},rr:rr,toast:toast,' +
  'veh:function(){Object.keys(S.veh||{}).forEach(function(k){if(VLIST.indexOf(k)<0)VLIST.push(k)});' +
  'for(var q=VLIST.length-1;q>=0;q--)if(!S.veh[VLIST[q]])VLIST.splice(q,1)},' +
  'me:function(n,i,pid){var r=ROLES[ROLE];if(r&&n){r.n=n;r.i=i}if(pid)ME_PID=pid;show(cur,true)}};';
const SAVE = 'function save(){try{HHLS.setItem(SKEY,JSON.stringify(S))}catch(e){}}';
const SAVE2 =
  'function save(){try{HHLS.setItem(SKEY,JSON.stringify(S))}catch(e){}' +
  'try{if(window.__hhOnSave)window.__hhOnSave()}catch(e){}}';

const link = `<script>(function(){
var B=null,H=null,L={on:false,meta:{},snap:{},q:Promise.resolve(),act:null};
function ready(){try{B=B||parent.__hhV36}catch(e){}H=window.__HH;return !!(B&&H&&H.S)}
function recs(k){var m=L.meta[k],v=H.S[k];if(m.shape==='value')return v===undefined||v===null?{}:{_:v};if(!v)return {};if(m.shape==='map')return v;var o={};v.forEach(function(r){o[String(r[m.idField])]=r});return o}
function snap(k){var o={},r=recs(k);for(var id in r)o[id]=JSON.stringify(r[id]);L.snap[k]=o}
function overlay(d){for(var k in d){H.S[k]=d[k];snap(k);if(k==='veh')H.veh()}}
function load(){if(!ready())return Promise.resolve();return B.state(H.TODAY).then(function(r){r.connected.forEach(function(c){L.meta[c.key]=c});
 if(!B.viewAs&&r.me)H.me(r.me.name,r.me.initials,r.me.staffNo);
 if(!r.needsImport.length){overlay(r.data);L.on=true;H.rr();return}
 return B.importData({today:H.TODAY,data:H.S}).then(function(x){overlay(x.data);L.on=true;H.rr()})})}
function diff(){var ch=[];for(var k in L.meta){var cur=recs(k),old=L.snap[k]||{},id;
 for(id in cur){var j=JSON.stringify(cur[id]);if(old[id]!==j)ch.push({key:k,id:id,before:old[id]?JSON.parse(old[id]):null,after:JSON.parse(j)})}
 for(id in old)if(!(id in cur))ch.push({key:k,id:id,before:JSON.parse(old[id]),after:null})}return ch}
function send(){if(!L.on)return;var ch=diff();if(!ch.length)return;var act=L.act;
 return B.sync({act:act,today:H.TODAY,changes:ch}).then(function(r){overlay(r.data);H.rr()},function(e){
  H.toast('<b>Not saved</b> · '+String((e&&e.detail)||'the server refused this change').replace(/</g,'&lt;'));return load()})}
window.__hhOnSave=function(){L.q=L.q.then(send,send)};
window.__hhLinkLoad=function(){L.q=L.q.then(load,load);return L.q};
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('[data-act]');if(a)L.act=a.getAttribute('data-act')},true);
})();</script>`;

let html = readFileSync(src, 'utf8');
const once = (needle, by) => {
  const i = html.indexOf(needle);
  if (i < 0 || html.indexOf(needle, i + 1) >= 0)
    throw new Error('v36: expected exactly one ' + needle.slice(0, 40));
  html = html.slice(0, i) + by + html.slice(i + needle.length);
};
once('variantInit();', 'variantInit();' + hook);
once(SAVE, SAVE2);
const at = html.indexOf('<head>') + '<head>'.length;
if (at < 6) throw new Error('v36: <head> not found');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html.slice(0, at) + '\n' + bridge + link + html.slice(at));
console.log('v36 app →', out);
