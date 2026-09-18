import { randomUUID } from 'node:crypto';
import { ACTIONS, OBJECTS, availableActions, clamp, distance, findPath, initialWorld, type ActionId, type DecisionId, type Memory, type Mode, type Trace, type WorldState } from '../shared/world.ts';
import { ProviderError, type Providers } from './providers.ts';

/** The single authority. Rendering, chat, and LLM output cannot call startAction. */
export class AgentRuntime {
  state:WorldState;
  private listeners=new Set<(state:WorldState)=>void>();
  private fastAbort:AbortController|null=null;
  private slowAbort:AbortController|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;
  private epoch=0;
  private nextDecision=0;
  private failures=0;
  private reflectedAt=-1;
  private slowCooldown=0;
  private autonomyHeld=false;
  private lastEmit=0;
  constructor(private providers:Providers,mode:Mode='demo',private saveMemories:(memories:Memory[])=>void=()=>{}){this.state=initialWorld(mode)}
  onChange(fn:(state:WorldState)=>void){this.listeners.add(fn);return ()=>this.listeners.delete(fn)}
  snapshot(){return structuredClone(this.state)}
  emit(){for(const fn of this.listeners)fn(this.state)}
  start(){if(this.timer)return;let last=Date.now();this.nextDecision=Date.now()+900;this.timer=setInterval(()=>{const now=Date.now();this.step(Math.min((now-last)/1000,.4));last=now;if(!this.state.paused&&now>=this.nextDecision&&!this.fastAbort&&!this.autonomyHeld)void this.decide();if(now-this.lastEmit>200){this.lastEmit=now;this.emit()}},50)}
  dispose(){if(this.timer)clearInterval(this.timer);this.timer=null;this.invalidate();this.listeners.clear()}
  private trace(kind:Trace['kind'],title:string,detail:string,extra:Partial<Trace>={}){
    this.state.traces.push({id:randomUUID(),at:Date.now(),kind,title,detail,mode:this.state.mode,...extra});this.state.traces=this.state.traces.slice(-160);
  }
  private message(text:string,source:string,role:'agent'|'system'='agent'){
    this.state.messages.push({id:randomUUID(),at:Date.now(),role,text,source});this.state.messages=this.state.messages.slice(-120);
  }
  private invalidate(){this.epoch++;this.state.revision++;this.fastAbort?.abort();this.slowAbort?.abort();this.fastAbort=null;this.slowAbort=null;this.state.fast.status='idle';this.state.slow.status='idle'}
  chat(text:string){
    if(!text.trim()||text.length>2000)throw new Error('消息需为 1–2000 个字符');
    const id=randomUUID();this.invalidate();this.state.advice=null;this.slowCooldown=0;this.autonomyHeld=false;
    this.state.messages.push({id,role:'user',text:text.trim(),at:Date.now(),source:'你'});this.state.messages=this.state.messages.slice(-120);
    this.state.request={id,text:text.trim(),completed:[],status:'active'};this.nextDecision=Date.now();
    this.trace('runtime','收到新消息','仅更新观察状态；没有直接解析或执行动作。正在等待快系统选择。');this.emit();return id;
  }
  control(action:'pause'|'resume'|'speed'|'reset'|'restock',value?:number){
    if(action==='pause'){this.invalidate();this.state.paused=true}
    if(action==='resume'){this.invalidate();this.state.paused=false;this.autonomyHeld=false;this.nextDecision=Date.now()}
    if(action==='speed'){if(value!==1&&value!==3)throw new Error('速度只支持 1 或 3');this.state.speed=value}
    if(action==='restock'){this.state.resources.food=Math.min(24,this.state.resources.food+3);this.invalidate();this.nextDecision=Date.now();this.trace('runtime','环境变化','用户补充了 3 份食材，快系统将重新观察。')}
    if(action==='reset'){const {mode,memories}=this.state;this.invalidate();this.state=initialWorld(mode);this.state.memories=memories;this.autonomyHeld=false;this.reflectedAt=-1;this.slowCooldown=0;this.nextDecision=Date.now()+500}
    this.emit();
  }
  configure(mode:Mode,memories:Memory[]=[]){this.invalidate();this.state.mode=mode;this.state.memories=memories;this.state.advice=null;this.state.agent.action=null;const fresh=initialWorld(mode);this.state.fast=fresh.fast;this.state.slow=fresh.slow;this.slowCooldown=0;this.failures=0;this.autonomyHeld=false;this.nextDecision=Date.now()+100;this.trace('runtime','模型配置更新',mode==='live'?'已切换真实 Jev；失败时不会降级为模拟。':'已切换本地规则模拟；不会调用真实模型。');this.emit()}
  step(realSeconds:number){
    const s=this.state;if(s.paused)return;const dt=clamp(realSeconds,0,1)*s.speed;
    s.clock=(s.clock+dt*.8)%(24*60);
    const decay={food:.09,water:.13,energy:.06,mood:.035,clean:.045};
    for(const k of Object.keys(decay) as (keyof typeof decay)[])s.agent.needs[k]=clamp(s.agent.needs[k]-dt*decay[k]);
    s.resources.plantWater=clamp(s.resources.plantWater-dt*.055);
    const a=s.agent.action;if(!a)return;
    if(a.phase==='walking'){
      let remaining=dt*1.7;
      while(a.path.length&&remaining>0){const target=a.path[0],d=distance(s.agent.position,target);if(d<=remaining){s.agent.position={...target};a.path.shift();remaining-=d}else{const f=remaining/d;s.agent.position={x:s.agent.position.x+(target.x-s.agent.position.x)*f,z:s.agent.position.z+(target.z-s.agent.position.z)*f};remaining=0}}
      if(!a.path.length){a.phase='acting';a.progress=0;this.trace('runtime','到达交互点',ACTIONS[a.id].doing)}
    }else{
      a.progress=clamp(a.progress+dt/ACTIONS[a.id].seconds,0,1);
      if(a.progress>=1)this.completeAction();
    }
  }
  private completeAction(){
    const s=this.state,a=s.agent.action;if(!a)return;
    if(!availableActions(s).includes(a.id)){s.agent.action=null;this.trace('error','动作前提已失效','没有扣除资源或应用完成效果。');this.nextDecision=Date.now();return}
    const def=ACTIONS[a.id];for(const [k,v] of Object.entries(def.effects))s.agent.needs[k as keyof typeof s.agent.needs]=clamp(s.agent.needs[k as keyof typeof s.agent.needs]+v!);
    if(a.id==='cook'){s.resources.food--;s.resources.meals++}if(a.id==='snack')s.resources.food--;if(a.id==='eat')s.resources.meals--;
    if(a.id==='water_plants')s.resources.plantWater=clamp(s.resources.plantWater+50);if(a.id==='toggle_light')s.resources.lampOn=!s.resources.lampOn;
    if(s.request?.id===a.requestId&&s.request.status==='active')s.request.completed.push(a.id);
    s.completedCount++;s.agent.action=null;s.revision++;
    this.fastAbort?.abort();this.fastAbort=null;s.fast.status='idle';
    this.trace('runtime','动作完成',def.label+' · 已由世界状态确认');this.nextDecision=Date.now()+550;this.emit();
  }
  candidates(){
    const s=this.state,c:Record<string,string>={continue:s.agent.action?'继续当前动作，不重复启动':'暂时等待，观察环境',stop:'停止当前动作并保持等待，直到用户给出新消息或恢复运行'};
    for(const id of availableActions(s)){const a=ACTIONS[id];c[id]=`${a.label}；对象=${a.object}；耗时=${a.seconds}秒；需求变化=${JSON.stringify(a.effects)}`}
    if(s.request?.status==='active')c.finish_request='当前用户请求已实际满足（查看 completed 和对话），标记完成；不可伪造成功。不支持的要求可说明能力边界后结束。';
    const reflectReady=s.completedCount>=5&&s.completedCount-this.reflectedAt>=5;
    if(this.providers.slowReady()&&!this.slowAbort&&Date.now()>=this.slowCooldown){c.consult_llm='请求 LLM 进行一次慢思考或自然语言对话。它只返回建议/回复，不能控制动作。适用于复杂规划、开放问题、歧义。';c.reflect_memory='请求 LLM 沉淀有明确用户消息来源的偏好/经验；用于用户要求记住某事或需要整理已有经验。不重复记同一来源。'}
    return {state:this.snapshot(),candidates:c,reflectReady};
  }
  async decide(){
    const s=this.state;if(s.paused||this.fastAbort||this.autonomyHeld)return;
    const ctrl=new AbortController(),epoch=this.epoch;this.fastAbort=ctrl;s.fast.status='thinking';s.fast.calls++;this.nextDecision=Date.now()+2500;this.emit();
    try{
      const input=this.candidates();const result=await this.providers.fast(input,ctrl.signal);
      if(ctrl.signal.aborted||epoch!==this.epoch||s!==this.state)return;
      if(!Object.hasOwn(input.candidates,result.choice))throw new ProviderError('拒绝执行不在本次候选集中的决策');
      s.fast.status='idle';s.fast.error=null;s.fast.lastLatency=result.latency;s.fast.lastChoice=result.choice;this.failures=0;
      this.trace('jev',s.mode==='demo'?'本地规则选择':'Jev 行为选择',input.candidates[result.choice],{choice:result.choice,latency:result.latency,probabilities:result.probabilities,confidence:result.confidence});
      this.applyDecision(result.choice);
    }catch(err){if(ctrl.signal.aborted||epoch!==this.epoch)return;const message=err instanceof ProviderError?err.message:'决策请求失败或超时；未执行新动作';s.fast.status='error';s.fast.error=message;this.failures++;this.nextDecision=Date.now()+Math.min(60000,3000*2**Math.min(this.failures-1,4));this.trace('error','快系统不可用',message+'。不启用模拟兜底。')}
    finally{if(this.fastAbort===ctrl)this.fastAbort=null;this.emit()}
  }
  private applyDecision(id:DecisionId){
    const s=this.state;
    if(id==='continue'){if(s.agent.action&&s.request?.status==='active')s.agent.action.requestId=s.request.id;this.nextDecision=Date.now()+(s.agent.action?4500:2500);return}
    if(id==='stop'){s.agent.action=null;if(s.request)s.request.status='done';this.autonomyHeld=true;this.message('我停下来了。给我新的指令再开始。','快系统选择 · 模板');return}
    if(id==='finish_request'){if(s.request){s.request.status='done';const done=s.request.completed.map(a=>ACTIONS[a].label);this.message(done.length?`这次已经完成：${done.join('、')}。`:'这条消息已处理。没有额外执行生活动作。','世界执行记录 · 模板')}return}
    if(id==='consult_llm'||id==='reflect_memory'){void this.think(id==='consult_llm'?'consult':'reflect');return}
    if(s.agent.action?.id===id){if(s.request?.status==='active')s.agent.action.requestId=s.request.id;return}
    if(!availableActions(s).includes(id)){this.trace('error','决策已过期','当前资源不再满足动作前提');return}
    const object=OBJECTS.find(o=>o.id===ACTIONS[id].object)!;const path=findPath(s.agent.position,object.approach);
    if(!path){this.trace('error','交互点不可达','拒绝穿过墙或家具；等待快系统重新选择。');return}
    const old=s.agent.action;s.agent.action={id,phase:'walking',path,progress:0,requestId:s.request?.status==='active'?s.request.id:null};
    this.trace('runtime',old?'切换行动':'开始行动',`${old?ACTIONS[old.id].label+' → ':''}${ACTIONS[id].label}。寻路与动画由确定性执行器负责。`);
    if(s.request?.status==='active')this.message(`好，我${ACTIONS[id].label}。`,'快系统选择 · 模板');
  }
  private async think(purpose:'consult'|'reflect'){
    if(this.slowAbort||!this.providers.slowReady())return;
    const ctrl=new AbortController(),epoch=this.epoch,s=this.state;this.slowAbort=ctrl;s.slow.status='thinking';s.slow.calls++;s.slow.error=null;this.slowCooldown=Date.now()+12000;
    this.trace('llm','由快系统发起慢思考',purpose==='reflect'?'整理经验与明确偏好':'生成建议或对话；现有行动可以继续');this.emit();
    try{
      const result=await this.providers.slow(this.snapshot(),purpose,ctrl.signal);
      if(ctrl.signal.aborted||epoch!==this.epoch||s!==this.state)return;
      s.advice={summary:result.summary,suggestions:result.suggestions,at:Date.now(),requestId:s.request?.id??null};
      if(result.reply)this.message(result.reply,s.mode==='demo'?'慢系统模拟 · 模板':'LLM · Jev 按需调用');
      if(purpose==='reflect'){
        for(const m of result.memories){if(!s.messages.some(x=>x.id===m.sourceMessageId&&x.role==='user'))continue;if(s.memories.some(x=>x.text===m.text&&x.sourceMessageId===m.sourceMessageId))continue;s.memories.push({...m,id:randomUUID(),at:Date.now(),mode:s.mode})}
        s.memories=s.memories.slice(-100);this.saveMemories(structuredClone(s.memories));this.reflectedAt=s.completedCount;
      }
      s.slow.status='idle';s.slow.lastLatency=result.latency;this.trace('llm','慢思考已返回',`${result.summary}（只更新建议；没有调用动作执行器。）`,{latency:result.latency});this.nextDecision=Date.now()+150;
    }catch(err){if(ctrl.signal.aborted||epoch!==this.epoch)return;s.slow.status='error';s.slow.error=err instanceof ProviderError?err.message:'慢思考失败或超时';this.trace('error','慢系统不可用',s.slow.error);this.message('慢思考暂时不可用。当前行动不会被未完成的建议覆盖。','运行时状态 · 模板','system')}
    finally{if(this.slowAbort===ctrl)this.slowAbort=null;this.emit()}
  }
}
