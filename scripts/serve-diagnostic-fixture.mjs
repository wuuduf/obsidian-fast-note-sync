import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';

const root = new URL('..', import.meta.url).pathname;
const stub = `export class ItemView{}; export class WorkspaceLeaf{}; export class TFile{}; export class FileView{}; export class MenuItem{};
export class Menu { addItem(){return this} addSeparator(){return this} showAtMouseEvent(){} }
export class Notice { constructor(text){window.__lastNotice=text} }
export const Platform={isMobile:window.innerWidth<600}; export const normalizePath=x=>x;
export const moment=()=>({format:()=>"11:12:13"}); export const setIcon=(el,icon)=>{el.textContent=({copy:'⧉',settings:'⚙',filter:'☷','trash-2':'⌫',wifi:'◉'})[icon]||'·'};`;
const contents = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SyncLogComponent} from './src/views/sync-log-view'; import {SyncLogManager} from './src/lib/sync/sync_log_manager';
HTMLElement.prototype.empty=function(){this.replaceChildren()};
const events=new Map(); const plugin={settings:{vault:'Test',showUpgradeBadge:false},manifest:{id:'fast-note-sync'},localStorageManager:{},app:{workspace:{on(name,fn){events.set(name,fn)},off(name){events.delete(name)}},vault:{adapter:{stat:async()=>null,append:async()=>{},write:async()=>{}}}},versionManager:{hasNewVersion:()=>false},websocket:{isConnected:()=>true,addStatusListener(){},removeStatusListener(){}},menuManager:{showRibbonMenu(){}},retryFailedLog:()=>false};
const manager=SyncLogManager.getInstance();
manager.addOrUpdateLog({id:'first',type:'receive',action:'NoteSync_full',status:'error',message:'读取失败，可以重试此页',path:'Blog/相册记录.md',vault:'Test',traceId:'trace-mobile-root-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJK'.slice(0,64),retryable:true,retryType:'note',retryContext:'fixture-context',retryPageIndex:2,retryState:'failed'});
manager.addOrUpdateLog({id:'other',type:'receive',action:'FileDownload',status:'error',message:'文件写入失败',path:'assets/photo.jpg',vault:'Test',traceId:'another-round-root',retryable:false});
window.__fixture={manager,plugin}; createRoot(document.getElementById('root')).render(React.createElement(SyncLogComponent,{plugin}));`;
const result = await build({ stdin: { contents, resolveDir: root, loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, plugins: [{ name: 'fixture-adapters', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'fixture' }));
  builder.onResolve({ filter: /(?:^|\/)utils\/helpers$/ }, () => ({ path: 'helpers', namespace: 'fixture' }));
  builder.onResolve({ filter: /i18n\/lang$/ }, () => ({ path: 'lang', namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'obsidian' ? stub : args.path === 'helpers' ? 'export const dumpError=()=>{}; export const getPluginDir=()=>"fixture";' : `import labels from ${JSON.stringify(root + 'src/i18n/locales/zh-CN.ts')}; export const $=(key)=>labels[key]||key;`, loader: 'js', resolveDir: root }));
} }] });
const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同步日志诊断验收</title><link rel="stylesheet" href="/styles.css"><style>:root{--background-primary:#fff;--background-secondary:#f6f7f9;--background-modifier-border:#ddd;--text-normal:#222;--text-muted:#646464;--text-error:#b62424;--interactive-accent:#7464c6;--text-on-accent:#fff}*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;font-size:14px}#root{height:100vh;max-width:760px;margin:auto}button,input{font:inherit}button{background:#f7f7f7;border:1px solid #ddd;border-radius:4px;cursor:pointer}input{border:1px solid #999;border-radius:4px}</style><div id="root"></div><script src="/fixture.js"></script></html>';
const server = http.createServer((request, response) => {
  const file = request.url === '/fixture.js' ? ['text/javascript', result.outputFiles[0].text] : request.url === '/styles.css' ? ['text/css', fs.readFileSync(new URL('../styles.css', import.meta.url))] : ['text/html', html];
  response.writeHead(200, { 'Content-Type': file[0] }); response.end(file[1]);
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}` })));
process.on('SIGTERM', () => server.close());
