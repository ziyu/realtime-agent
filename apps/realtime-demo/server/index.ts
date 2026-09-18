import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadRuntimeConfig } from '@realtime-agent/config';
import { createServer as createViteServer } from 'vite';
import { createProviders, safeBaseUrl, type Settings } from './providers.ts';
import { AgentRuntime } from './runtime.ts';
import { createApi } from './http.ts';
import type { Memory, Mode } from '../shared/world.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=loadRuntimeConfig({appDirectory:root,defaultPort:3007});
const port=config.port;
const settings:Settings={mode:config.mode,jevKey:config.systemOne.apiKey,jevModel:config.systemOne.model,jevBaseUrl:config.systemOne.baseUrl,llmKey:config.llm.apiKey,llmBaseUrl:config.llm.baseUrl,llmModel:config.llm.model};
const dataDir=config.dataDirectory;
const memSchema=z.array(z.object({id:z.string(),text:z.string().max(300),sourceMessageId:z.string(),at:z.number(),mode:z.enum(['demo','live'])})).max(100);
function loadMemories(mode:Mode):Memory[]{try{const file=path.join(dataDir,`memories-${mode}.json`);if(!existsSync(file))return [];return memSchema.parse(JSON.parse(readFileSync(file,'utf8')))}catch{console.warn('Memory file could not be loaded; starting without memories.');return []}}
const runtime=new AgentRuntime(createProviders(()=>settings),settings.mode,memories=>{try{mkdirSync(dataDir,{recursive:true,mode:0o700});const file=path.join(dataDir,`memories-${settings.mode}.json`);writeFileSync(file+'.tmp',JSON.stringify(memories,null,2),{mode:0o600});renameSync(file+'.tmp',file)}catch{console.warn('Memory persistence failed; in-session memories are retained.')}});
runtime.state.memories=loadMemories(settings.mode);
const api=createApi(runtime,settings,loadMemories);
const production=process.env.NODE_ENV==='production';
if(production&&!existsSync(path.join(root,'dist/index.html')))throw new Error('Run pnpm run build before production start');
const server=createServer(async(req,res)=>{
  try{const host=new URL(`http://${req.headers.host}`);if(!['localhost','127.0.0.1','[::1]'].includes(host.hostname)||Number(host.port)!==port){res.writeHead(403);res.end('Localhost only');return}}catch{res.writeHead(400);res.end();return}
  if(await api(req,res))return;
  if(vite){vite.middlewares(req,res);return}
  let pathname:string;try{pathname=decodeURIComponent(new URL(req.url||'/','http://localhost').pathname)}catch{res.writeHead(400);res.end();return}
  const base=path.join(root,'dist');let file=path.resolve(base,'.'+pathname);
  if(!file.startsWith(base+path.sep)&&file!==base){res.writeHead(403);res.end();return}
  if(path.extname(file)==='')file=path.join(base,'index.html');
  try{const content=await readFile(file);const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(content)}catch{res.writeHead(404);res.end('Not found')}
});
const vite=production?null:await createViteServer({root,server:{middlewareMode:true,hmr:{server}},appType:'spa'});
server.on('error',err=>{console.error(`RealtimeAgent failed to start: ${err.message}`);runtime.dispose();void vite?.close();process.exitCode=1});
server.listen(port,'127.0.0.1',()=>{runtime.start();console.log(`\n  RealtimeAgent → http://localhost:${port}\n  ${settings.mode==='demo'?'OFFLINE DEMO — local rules, no models called':'LIVE — Jev owns every action decision'}\n`)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{runtime.dispose();server.closeAllConnections();server.close();void vite?.close().then(()=>process.exit(0));if(!vite)process.exit(0)});
