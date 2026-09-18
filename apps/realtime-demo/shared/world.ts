/** Shared geometry is also the authority for collisions: visuals never decide actions. */
export type Point = { x: number; z: number };
export type Need = 'food' | 'water' | 'energy' | 'mood' | 'clean';
export type Mode = 'demo' | 'live';
export type ActionId = 'snack' | 'cook' | 'eat' | 'drink' | 'sleep' | 'shower' | 'work' | 'read' | 'rest' | 'water_plants' | 'sit' | 'toggle_light';
export type DecisionId = ActionId | 'continue' | 'stop' | 'finish_request' | 'consult_llm' | 'reflect_memory';
export interface Rect { x: number; z: number; w: number; d: number }
export interface WorldObject extends Rect { id: string; name: string; room: string; color: string; approach: Point; actions: ActionId[] }
export interface Action { id: ActionId; label: string; doing: string; object: string; seconds: number; effects: Partial<Record<Need, number>> }
export const OBJECTS: WorldObject[] = [
  {id:'fridge',name:'冰箱',room:'厨房',x:-5,z:-3.8,w:1,d:.9,color:'#a8c5b7',approach:{x:-5,z:-2.8},actions:['snack']},
  {id:'stove',name:'料理台',room:'厨房',x:-3.3,z:-3.85,w:1.6,d:.9,color:'#dac6a5',approach:{x:-3.3,z:-2.8},actions:['cook']},
  {id:'sink',name:'水槽',room:'厨房',x:-1.45,z:-3.85,w:1.2,d:.9,color:'#ded9c4',approach:{x:-1.5,z:-2.8},actions:['drink']},
  {id:'table',name:'餐桌',room:'厨房',x:-3.4,z:-1.35,w:1.4,d:.75,color:'#bb926c',approach:{x:-2.4,z:-1.3},actions:['eat']},
  {id:'bed',name:'床',room:'卧室',x:3,z:-3.1,w:1.7,d:2.3,color:'#a9c9c1',approach:{x:4.25,z:-2.9},actions:['sleep']},
  {id:'shower',name:'淋浴间',room:'卧室',x:5.3,z:-3.65,w:1.1,d:1.25,color:'#c9dad5',approach:{x:5.25,z:-2.45},actions:['shower']},
  {id:'lamp',name:'床头灯',room:'卧室',x:1.6,z:-3.8,w:.55,d:.6,color:'#d7bf8e',approach:{x:1.6,z:-2.8},actions:['toggle_light']},
  {id:'desk',name:'工作桌',room:'书房',x:-4.65,z:1.5,w:1.8,d:.8,color:'#b8906a',approach:{x:-4.6,z:2.45},actions:['work']},
  {id:'bookshelf',name:'书架',room:'书房',x:-2.3,z:1.15,w:1.2,d:.6,color:'#c6b590',approach:{x:-2.3,z:2.1},actions:['read']},
  {id:'sofa',name:'沙发',room:'书房',x:-3.25,z:4,w:2.05,d:.9,color:'#b8a9c9',approach:{x:-3.2,z:3.1},actions:['rest']},
  {id:'planter',name:'花圃',room:'花园',x:4.3,z:3.8,w:2.05,d:.85,color:'#91aa73',approach:{x:4.3,z:2.9},actions:['water_plants']},
  {id:'bench',name:'长椅',room:'花园',x:2,z:1.9,w:1.65,d:.65,color:'#b99876',approach:{x:2,z:2.8},actions:['sit']},
];
export const WALLS: Rect[] = [
  {x:-3.4,z:-4.7,w:5.5,d:.16}, {x:3.4,z:-4.7,w:5.5,d:.16},
  {x:-6.1,z:-2.9,w:.16,d:3.75}, {x:.7,z:-3.15,w:.16,d:3.15},
  {x:-3.9,z:.7,w:4.4,d:.16}, {x:-6.1,z:2.7,w:.16,d:4.1},
];
export const ACTIONS: Record<ActionId, Action> = {
  snack:{id:'snack',label:'从冰箱拿点吃的',doing:'吃点零食',object:'fridge',seconds:5,effects:{food:28,mood:3}},
  cook:{id:'cook',label:'做一份饭',doing:'准备料理',object:'stove',seconds:9,effects:{energy:-4}},
  eat:{id:'eat',label:'去餐桌吃饭',doing:'享用料理',object:'table',seconds:6,effects:{food:45,mood:8}},
  drink:{id:'drink',label:'去喝水',doing:'喝一杯水',object:'sink',seconds:4,effects:{water:40}},
  sleep:{id:'sleep',label:'去睡一会儿',doing:'休息补充精力',object:'bed',seconds:12,effects:{energy:48}},
  shower:{id:'shower',label:'去洗澡',doing:'洗个热水澡',object:'shower',seconds:8,effects:{clean:45,mood:5}},
  work:{id:'work',label:'去书房工作',doing:'专注工作',object:'desk',seconds:12,effects:{energy:-10,mood:-4}},
  read:{id:'read',label:'去读一本书',doing:'读几页书',object:'bookshelf',seconds:9,effects:{mood:16,energy:-2}},
  rest:{id:'rest',label:'在沙发上休息',doing:'窝在沙发里',object:'sofa',seconds:8,effects:{energy:18,mood:10}},
  water_plants:{id:'water_plants',label:'给花园浇水',doing:'照顾花草',object:'planter',seconds:6,effects:{mood:10,energy:-3}},
  sit:{id:'sit',label:'去花园坐坐',doing:'享受花园时光',object:'bench',seconds:8,effects:{mood:18}},
  toggle_light:{id:'toggle_light',label:'切换床头灯',doing:'调整床头灯',object:'lamp',seconds:2,effects:{}},
};
export const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v));
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
export function isWalkable(p: Point): boolean {
  if (p.x < -6.4 || p.x > 6.4 || p.z < -5 || p.z > 5.1) return false;
  return ![...WALLS,...OBJECTS].some(r => Math.abs(p.x-r.x)<r.w/2+.2 && Math.abs(p.z-r.z)<r.d/2+.2);
}
/** A* on a 0.25-unit grid, four-connected (no corner cutting). */
export function findPath(start: Point, end: Point): Point[] | null {
  const step = .25, key=(p:Point)=>`${Math.round(p.x/step)},${Math.round(p.z/step)}`;
  const parse=(k:string):Point=>{const [x,z]=k.split(',').map(Number);return {x:x*step,z:z*step}};
  const s=key(start), goal=key(end);
  if (!isWalkable(start) || !isWalkable(end) || !isWalkable(parse(s)) || !isWalkable(parse(goal))) return null;
  const open=new Set([s]), came=new Map<string,string>(), g=new Map([[s,0]]), f=new Map([[s,distance(start,end)]]);
  for(let n=0;open.size&&n<8000;n++){
    let current='';let best=Infinity;
    for(const k of open){const v=f.get(k)??Infinity;if(v<best){best=v;current=k}}
    if(current===goal){const path:Point[]=[end];while(current!==s){path.unshift(parse(current));current=came.get(current)!}path.unshift(parse(s));return path}
    open.delete(current);const p=parse(current);
    for(const [dx,dz] of [[step,0],[-step,0],[0,step],[0,-step]]){
      const np={x:Math.round((p.x+dx)*100)/100,z:Math.round((p.z+dz)*100)/100},nk=key(np);
      if(!isWalkable(np))continue;const ng=g.get(current)!+step;
      if(ng<(g.get(nk)??Infinity)){came.set(nk,current);g.set(nk,ng);f.set(nk,ng+distance(np,end));open.add(nk)}
    }
  }
  return null;
}
export interface Message { id:string; role:'user'|'agent'|'system'; text:string; at:number; source:string }
export interface Memory { id:string; text:string; sourceMessageId:string; at:number; mode:Mode }
export interface Trace { id:string; at:number; kind:'jev'|'llm'|'runtime'|'error'; title:string; detail:string; mode:Mode; latency?:number; choice?:string; probabilities?:Record<string,number>; confidence?:number }
export interface Advice { summary:string; suggestions:string[]; at:number; requestId:string|null }
export interface CurrentAction { id:ActionId; phase:'walking'|'acting'; progress:number; path:Point[]; requestId:string|null }
export interface WorldState {
  mode:Mode; paused:boolean; speed:1|3; clock:number; revision:number;
  agent:{position:Point; needs:Record<Need,number>; action:CurrentAction|null};
  resources:{food:number; meals:number; plantWater:number; lampOn:boolean};
  messages:Message[]; memories:Memory[]; traces:Trace[]; advice:Advice|null;
  request:{id:string;text:string;completed:ActionId[];status:'active'|'done'}|null;
  fast:{status:'idle'|'thinking'|'error';calls:number;lastLatency:number|null;lastChoice:string;error:string|null};
  slow:{status:'idle'|'thinking'|'error';calls:number;lastLatency:number|null;error:string|null};
  completedCount:number;
}
export function initialWorld(mode:Mode='demo'):WorldState {
  return {mode,paused:false,speed:1,clock:9*60+30,revision:0,
    agent:{position:{x:-1,z:2.7},needs:{food:65,water:58,energy:78,mood:73,clean:82},action:null},
    resources:{food:6,meals:0,plantWater:48,lampOn:false},
    messages:[{id:'hello',role:'agent',text:'你好，我是 Milo。这是我的小小世界。和我聊聊天，或者让我去做点什么吧。',at:Date.now(),source:'欢迎语 · 模板'}],
    memories:[],traces:[],advice:null,request:null,
    fast:{status:'idle',calls:0,lastLatency:null,lastChoice:'等待世界醒来',error:null},
    slow:{status:'idle',calls:0,lastLatency:null,error:null},completedCount:0};
}
export function availableActions(s:WorldState):ActionId[]{
  return (Object.keys(ACTIONS) as ActionId[]).filter(id=>!(['snack','cook'].includes(id)&&s.resources.food<1)&&!(id==='eat'&&s.resources.meals<1));
}
