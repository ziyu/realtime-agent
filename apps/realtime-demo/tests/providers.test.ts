import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorld } from '../shared/world.ts';
import { parseSlowResponse, safeBaseUrl, createProviders, type Settings } from '../server/providers.ts';
const choices={drink:'喝水',consult_llm:'邀请慢思考'};
test('System One SDK owns the Jev wire contract and validates the returned Choice',async()=>{
  const original=globalThis.fetch;let body:any;
  globalThis.fetch=async(_input,init)=>{body=JSON.parse(String(init?.body));return Response.json({model:'jev-fixture',answers:{next_action:{type:'choice',choice:'drink',probabilities:{drink:.8,consult_llm:.2},confidence:.62}},usage:{input_tokens:5,output_tokens:2}})};
  try{const config:Settings={mode:'live',jevKey:'test-only-secret',jevModel:'jev-latest',llmKey:'',llmModel:'',llmBaseUrl:'https://example.com/v1'};const p=createProviders(()=>config);const result=await p.fast({state:initialWorld('live'),candidates:choices,reflectReady:false},new AbortController().signal);assert.equal(result.choice,'drink');assert.equal(result.confidence,.62);assert.equal(body.questions.next_action.type,'choice');assert.deepEqual(body.questions.next_action.criteria,choices)}finally{globalThis.fetch=original}
});
test('LLM response is parsed as advisory data with grounded source IDs only',()=>{const s=initialWorld();s.messages.push({id:'u1',role:'user',text:'喜欢安静',source:'user',at:1});const raw={choices:[{message:{content:JSON.stringify({summary:'建议',reply:'明白',suggestions:['drink','delete_all_files'],memories:[{text:'喜欢安静',sourceMessageId:'u1'},{text:'未提供的属性',sourceMessageId:'fake'}]})}}]};const parsed=parseSlowResponse(raw,s);assert.deepEqual(parsed.suggestions,['drink']);assert.equal(parsed.memories.length,1);assert.throws(()=>parseSlowResponse({choices:[{message:{content:'not JSON'}}]},s))});
test('custom endpoints reject credential-bearing URLs and remote plain HTTP',()=>{assert.equal(safeBaseUrl('http://localhost:11434/v1/'),'http://localhost:11434/v1');assert.equal(safeBaseUrl('https://example.com/v1'),'https://example.com/v1');for(const bad of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?key=x','file:///etc/passwd'])assert.throws(()=>safeBaseUrl(bad))});
test('live request targets the official API, keeps keys out of the body and surfaces HTTP failures',async()=>{
  const original=globalThis.fetch;let url='',body='',authorization='';
  globalThis.fetch=async(input,init)=>{url=String(input);body=String(init?.body);authorization=new Headers(init?.headers).get('Authorization')||'';return new Response('{}',{status:529})};
  try{const config:Settings={mode:'live',jevKey:'test-only-secret',jevModel:'jev-latest',llmKey:'',llmModel:'',llmBaseUrl:'https://example.com/v1'};const p=createProviders(()=>config);await assert.rejects(p.fast({state:initialWorld('live'),candidates:choices,reflectReady:false},new AbortController().signal),/529/);assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(authorization,'Bearer test-only-secret');assert.ok(!body.includes('test-only-secret'));assert.equal(p.slowReady(),false)}finally{globalThis.fetch=original}
});
