import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AgentRuntime } from '../server/runtime.ts';
import { createApi } from '../server/http.ts';
import type { Settings } from '../server/providers.ts';
test('local API protects writes, rejects cross-origin access and never returns provider keys',async()=>{
  const settings:Settings={mode:'demo',jevKey:'test-jev-secret',jevModel:'jev-latest',llmKey:'test-llm-secret',llmModel:'fixture',llmBaseUrl:'https://example.com/v1'};
  const r=new AgentRuntime({fast:async()=>({choice:'continue',probabilities:{continue:1},confidence:1,latency:1}),slow:async()=>({summary:'',reply:'',suggestions:[],memories:[],latency:1}),slowReady:()=>true});
  const api=createApi(r,settings);const server=createServer(async(req,res)=>{if(!await api(req,res)){res.writeHead(404);res.end()}});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try{
    const bootstrap=await(await fetch(`${base}/api/bootstrap`)).json();const serialized=JSON.stringify(bootstrap);assert.ok(!serialized.includes(settings.jevKey));assert.ok(!serialized.includes(settings.llmKey));assert.equal(bootstrap.settings.hasJevKey,true);
    assert.equal((await fetch(`${base}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'喝水'})})).status,403);
    assert.equal((await fetch(`${base}/api/bootstrap`,{headers:{Origin:'https://evil.example'}})).status,403);
    const headers={'Content-Type':'application/json','X-RA-Token':bootstrap.token};
    const malformed=await fetch(`${base}/api/settings`,{method:'POST',headers,body:'{"jevKey":"test-sensitive-json" BROKEN'});assert.equal(malformed.status,400);assert.ok(!(await malformed.text()).includes('test-sensitive-json'));
    const response=await fetch(`${base}/api/chat`,{method:'POST',headers,body:JSON.stringify({text:'先喝水，再读书'})});assert.equal(response.status,202);assert.equal(r.state.agent.action,null);assert.equal(r.state.request?.text,'先喝水，再读书');
    assert.equal((await fetch(`${base}/api/chat`,{method:'POST',headers,body:JSON.stringify({text:'x'.repeat(2001)})})).status,400);
    assert.equal((await fetch(`${base}/api/control`,{method:'POST',headers,body:JSON.stringify({action:'speed',value:7})})).status,400);
    const liveResponse=await fetch(`${base}/api/settings`,{method:'POST',headers,body:JSON.stringify({mode:'live',jevModel:'jev-latest',llmBaseUrl:'https://example.com/v1',llmModel:'',clearKeys:true})});assert.equal(liveResponse.status,400);assert.equal(settings.jevKey,'test-jev-secret');
    const clearResponse=await fetch(`${base}/api/settings`,{method:'POST',headers,body:JSON.stringify({mode:'demo',jevModel:'jev-latest',llmBaseUrl:'https://example.com/v1',llmModel:'',clearKeys:true})});assert.equal(clearResponse.status,200);assert.equal(settings.jevKey,'');assert.equal(settings.llmKey,'');
  }finally{r.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
