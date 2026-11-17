import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const repo='/Users/shuhei/Projects/genie';
const { simulationOrderIntent, canonicalSha256 }=await import(pathToFileURL(join(repo,'packages/contracts/dist/index.js')));
const { SimulationOrders }=await import(pathToFileURL(join(repo,'workers/agent-host/dist/simulation-orders.js')));
const { TransactionRuntime }=await import(pathToFileURL(join(repo,'workers/agent-host/dist/transaction-runtime.js')));
const { nativeSimulationConfirmation }=await import(pathToFileURL(join(repo,'workers/agent-host/dist/simulation-native-checkout.js')));
const root=process.env.ASTRA_DATA_ROOT;
const config={helper:'/private/tmp/genie-transactions-20261002/GenieComputerHelperPreview.app/Contents/MacOS/GenieComputerHelper',executable:join(repo,'.build/computer/GenieCheckoutSimulation.app/Contents/MacOS/GenieCheckoutSimulation')};
const nativeConfirm=nativeSimulationConfirmation(config);
const confirm=async(checkout,signal)=>{try{return await nativeConfirm(checkout,signal);}catch(error){console.error('NATIVE_CAUSE',error);throw error;}};
const adapter=new SimulationOrders({root:join(root,'provider'),confirm});
const runtime=new TransactionRuntime({journalDir:join(root,'journal'),adapters:[adapter]});
const results=[];
async function run(runtime,kind,key,signal){
 const intent=simulationOrderIntent(kind,key);
 const prepared=await runtime.run({id:'prepare-'+key,toolId:'transaction.prepare',args:{intent}});
 if(!prepared.ok)throw Error(JSON.stringify(prepared));
 const args=prepared.result.submitArgs;
 return runtime.run({id:'submit-'+key,toolId:'transaction.submit',args,approval:{approvalId:'native-lifecycle-fixture-approval',operationId:'transaction.submit',decision:'APPROVED',decidedBy:'explicit-simulation-test',decidedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+240000).toISOString(),inputsHash:await canonicalSha256(args)}},signal);
}
try{
 for(const [kind,key] of [['pizza','session-reuse-1'],['burger','session-reuse-2']]){
  console.log('BEGIN',key);
  const result=await run(runtime,kind,key);
  console.log('RESULT',key,JSON.stringify(result));
  results.push({key,result});
  if(!result.ok)throw Error('native_baseline_failed');
 }
 const records=[];
 for(const name of await readdir(join(root,'provider'))){
  const directory=join(root,'provider',name);
  records.push({directory,window:JSON.parse(await readFile(join(directory,'window.json'),'utf8')),receipt:JSON.parse(await readFile(join(directory,'receipt.json'),'utf8'))});
 }
 if(records.length!==2||records[0].window.pid!==records[1].window.pid||records[0].window.windowId!==records[1].window.windowId||records[0].window.commandId===records[1].window.commandId||records.some(r=>r.window.clicks!==1||r.window.activations!==0))throw Error('native_reuse_mismatch');
 const cancelledRuntime=new TransactionRuntime({journalDir:join(root,'cancel-journal'),adapters:[new SimulationOrders({root:join(root,'cancel-provider'),confirm:nativeSimulationConfirmation(config)})]});
 const cancel=new AbortController();
 const timer=setTimeout(()=>cancel.abort(Error('explicit-native-abort-test')),2000);
 console.log('BEGIN active-abort-no-consent');
 const cancelled=await run(cancelledRuntime,'pizza','session-aborted',cancel.signal);clearTimeout(timer);
 console.log('RESULT active-abort',JSON.stringify(cancelled));
 await delay(250);
 const cancelRecords=[];
 for(const name of await readdir(join(root,'cancel-provider'))){
  const directory=join(root,'cancel-provider',name);
  const files=await readdir(directory);
  cancelRecords.push({directory,files,window:files.includes('window.json')?JSON.parse(await readFile(join(directory,'window.json'),'utf8')):null});
 }
 if(cancelRecords.some(r=>r.files.includes('receipt.json')))throw Error('aborted_order_has_receipt');
 await writeFile(join(root,'result.json'),JSON.stringify({at:new Date().toISOString(),classification:'implementation native integration verification: explicit fictional test proof, production consent via operator/CUA, no real purchase',results,records,cancelled,cancelRecords},null,2));
 console.log('NATIVE_SESSION_REUSE_PASS');process.exit(0);
}catch(error){console.error(error);await writeFile(join(root,'failure.json'),JSON.stringify({message:String(error),results},null,2));process.exit(1);}
