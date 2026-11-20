import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {chatAssistant,parseAssistantResponse} from '../server/assistant.mjs';

const context={selectedMaterial:'m1',current:{style:'premium'},materials:[{id:'m1',name:'金属',count:2,values:{color:'#333333'}}],parts:[{id:'p1',material:'m1'},{id:'p2',material:'m1'}]};
const proposal={reply:'两处金属一起修改',changes:[{target:'p2',property:'color',value:'#3a4045'}]};

test('响应结构区分提案、澄清、无差异和问答，并将部件目标归入共用材质',()=>{
  assert.equal(parseAssistantResponse('```json\n'+JSON.stringify(proposal)+'\n```',context).changes[0].target,'m1');
  assert.throws(()=>parseAssistantResponse(JSON.stringify({reply:'确认后修改',changes:[]}),context),/空修改/);
  for(const status of ['clarification','no_change','answer'])assert.equal(parseAssistantResponse(JSON.stringify({status,reply:'状态说明',changes:[]}),context).status,status);
  assert.throws(()=>parseAssistantResponse(JSON.stringify({...proposal,changes:[{target:'m99',property:'color',value:'#333333'}]}),context),/未识别/);
  assert.throws(()=>parseAssistantResponse(JSON.stringify({...proposal,changes:[{target:'m1',property:'roughness',value:9}]}),context),/范围/);
});

test('格式错误自动修复一次；再次失败明确报错，不伪装为成功但无变化',async()=>{
  const bodies=[];let alwaysBad=false;
  const provider=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const content=alwaysBad||bodies.length===1?'准备修改，请确认':JSON.stringify(proposal);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  try{
    const config={url:'http://127.0.0.1:'+provider.address().port,model:'fixture',key:''};
    const input={messages:[{role:'user',content:'把框架改成深灰金属'}],scene:context};
    const traces=[];
    const result=await chatAssistant(config,input,async event=>{traces.push(event);});
    assert.equal(result.repaired,true);assert.equal(result.changes[0].target,'m1');
    assert.equal(bodies.length,2);assert.deepEqual(traces.map(t=>t.phase),['repair','response']);
    assert.match(bodies[1].messages.at(-1).content,/工作台校验失败/);
    assert.match(bodies[0].messages[0].content,/唯一编辑单位是共用材质/);
    alwaysBad=true;await assert.rejects(chatAssistant(config,input),/连续两次未通过校验/);
    assert.equal(bodies.length,4);
  }finally{provider.closeAllConnections();await new Promise(resolve=>provider.close(()=>resolve()));}
});
