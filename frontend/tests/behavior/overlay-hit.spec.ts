import {test,expect} from '../support/test';
import {createScenario,openApp,marker} from '../support/scenario';
import {routingScenario} from '../support/routing';
for(const surface of ['settings','device','routing']) test(`X05 activity overlay leaves ${surface} primary action clickable`,async({page,baseURL},info)=>{
 await page.setViewportSize(surface==='routing'?{width:1440,height:1000}:{width:390,height:844});
 const s=createScenario('X05');let action='';let path='';
 if(surface==='routing'){routingScenario(s);action='review-apply';path='/api/routing/apply';s.on('POST',path,()=>({status:409,body:{code:'busy',error:'Synthetic busy'}}));}
 else if(surface==='settings'){action='settings-save';path='/api/auto-update';s.on('PUT',path,r=>({body:{ok:true,config:r.body}}));}
 else {action='apply-device-location';path='/api/devices/location';s.on('POST',path,()=>({abort:true}));}
 await openApp(page,s,baseURL!);
 if(surface==='settings'){await marker(page,'btn-settings').click();await marker(page,'settings-subscription').click();await marker(page,'auto-update-time').fill('05:45');}
 else if(surface==='device'){await marker(page,'devices-toggle').click();await marker(page,'location-02:00:00:00:00:21').click();await marker(page,'device-location-option-de').check();}
 else{await marker(page,'nav-routing').click();await marker(page,'draft-review').click();}
 await marker(page,action).scrollIntoViewIfNeeded();await page.clock.runFor(48);
 const hit=await marker(page,action).evaluate(el=>{
  const r=el.getBoundingClientRect();const a=document.querySelector('[data-marker="btn-activity"]');const ar=a?.getBoundingClientRect();
  const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
  return {primary:r.toJSON(),activity:ar?.toJSON(),centerHitsPrimary:top===el||el.contains(top),overlap:ar?Math.max(0,Math.min(r.right,ar.right)-Math.max(r.left,ar.left))*Math.max(0,Math.min(r.bottom,ar.bottom)-Math.max(r.top,ar.top)):0};
 });
 await info.attach('hit-test',{body:JSON.stringify(hit),contentType:'application/json'});console.log(surface,JSON.stringify(hit));
 expect(hit.centerHitsPrimary).toBe(true);await marker(page,action).click();await expect.poll(()=>s.requests.filter(r=>r.path===path&&r.method!=='GET').length).toBe(1);
});
