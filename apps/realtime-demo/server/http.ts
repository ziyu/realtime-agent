import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { publicSettings, safeBaseUrl, type Settings } from './providers.ts';
import type { AgentRuntime } from './runtime.ts';
import type { Memory } from '../shared/world.ts';
const settingsSchema=z.object({mode:z.enum(['demo','live']),jevKey:z.string().max(4096).optional(),jevModel:z.string().trim().min(1).max(100),llmKey:z.string().max(4096).optional(),llmBaseUrl:z.string().max(1000),llmModel:z.string().max(150),clearKeys:z.boolean().optional()});
export function createApi(runtime:AgentRuntime,settings:Settings,loadMemories:(mode:Settings['mode'])=>Memory[]=()=>[]){
  const token=randomBytes(24).toString('hex');let clients=0;
  function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
  function sameOrigin(req:IncomingMessage){
    try{
      const origin=new URL(`http://${req.headers.host}`);
      if(!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||Number(origin.port)!==req.socket.localPort)return false;
      if(req.headers.origin&&req.headers.origin!==origin.origin)return false;
      return req.headers['sec-fetch-site']!=='cross-site';
    }catch{return false}
  }
  async function body(req:IncomingMessage){
    if(!req.headers['content-type']?.startsWith('application/json'))throw new Error('需要 JSON 请求');
    const chunks:Buffer[]=[];let size=0;const timer=setTimeout(()=>req.destroy(),10000);
    try{for await(const chunk of req){size+=chunk.length;if(size>16000)throw new Error('请求过大');chunks.push(Buffer.from(chunk))}try{return JSON.parse(Buffer.concat(chunks).toString()) as unknown}catch{throw new Error('请求不是有效 JSON')}}finally{clearTimeout(timer)}
  }
  return async (req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const path=req.url?.split('?')[0]??'/';if(!path.startsWith('/api/'))return false;
    if(!sameOrigin(req)){json(res,403,{error:'仅允许同源的本地请求'});return true}
    if(req.method==='POST'&&req.headers['x-ra-token']!==token){json(res,403,{error:'会话令牌无效，请刷新页面'});return true}
    try{
      if(req.method==='GET'&&path==='/api/bootstrap'){json(res,200,{token,settings:publicSettings(settings),state:runtime.snapshot()});return true}
      if(req.method==='GET'&&path==='/api/state'){json(res,200,runtime.snapshot());return true}
      if(req.method==='GET'&&path==='/api/settings'){json(res,200,publicSettings(settings));return true}
      if(req.method==='GET'&&path==='/api/events'){
        if(clients>=8){json(res,429,{error:'本地演示最多支持 8 个观察页面'});return true}clients++;
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
        const send=(s:unknown)=>{if(res.destroyed)return;if(res.writableLength>512000){res.end();return}res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`)};
        send(runtime.snapshot());const unsub=runtime.onChange(send),heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
        res.on('close',()=>{clients--;unsub();clearInterval(heartbeat)});return true;
      }
      if(req.method==='POST'&&path==='/api/chat'){const p=z.object({text:z.string().trim().min(1).max(2000)}).parse(await body(req));const id=runtime.chat(p.text);json(res,202,{id});return true}
      if(req.method==='POST'&&path==='/api/control'){const p=z.object({action:z.enum(['pause','resume','speed','reset','restock']),value:z.number().optional()}).parse(await body(req));runtime.control(p.action,p.value);json(res,200,{ok:true});return true}
      if(req.method==='POST'&&path==='/api/settings'){
        const p=settingsSchema.parse(await body(req));const next:Settings={mode:p.mode,jevModel:p.jevModel,jevBaseUrl:settings.jevBaseUrl,jevKey:p.clearKeys?'':p.jevKey?.trim()||settings.jevKey,llmKey:p.clearKeys?'':p.llmKey?.trim()||settings.llmKey,llmBaseUrl:safeBaseUrl(p.llmBaseUrl),llmModel:p.llmModel.trim()};
        if(next.mode==='live'&&!next.jevKey){json(res,400,{error:'真实模式需要 TypeSafe API Key'});return true}
        Object.assign(settings,next);runtime.configure(settings.mode,loadMemories(settings.mode));json(res,200,publicSettings(settings));return true;
      }
      json(res,404,{error:'接口不存在'});
    }catch(err){if(!res.headersSent&&!res.destroyed)json(res,400,{error:err instanceof z.ZodError?'输入字段无效，请检查长度与格式':err instanceof Error?err.message.slice(0,160):'请求失败'})}
    return true;
  };
}
