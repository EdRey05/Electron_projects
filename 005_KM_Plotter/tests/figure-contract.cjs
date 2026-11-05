const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
async function moduleAt(file){return import('data:text/javascript;base64,'+fs.readFileSync(path.join(__dirname,'..','src','lib',file)).toString('base64'));}
test('risk table independently accounts for ties, censoring and zero-time removals',async()=>{
 const {riskAt}=await moduleAt('figure.js');
 const curve={n:4,eventTable:[{time:0,atRisk:4,removed:1,observed:1,censored:0},{time:1,atRisk:3,removed:2,observed:1,censored:1},{time:2,atRisk:1,removed:1,observed:0,censored:1}]};
 assert.deepEqual(riskAt(curve,0),{atRisk:3,events:1,censored:0});
 assert.deepEqual(riskAt(curve,.5),{atRisk:3,events:1,censored:0});
 assert.deepEqual(riskAt(curve,1),{atRisk:1,events:2,censored:1});
 assert.deepEqual(riskAt(curve,3),{atRisk:0,events:2,censored:2});
});
test('figure reserves separated axis and risk bands for one and many curves',async()=>{
 const {figureGeometry}=await moduleAt('figure.js');
 for(const count of [1,2,5,25])for(const side of [false,true]){
  const g=figureGeometry({curves:Array(count).fill({}),showAtRisk:true,side});
  assert.ok(g.riskTitleY-g.axisTitleY>=40);
  assert.ok(g.totalHeight>g.riskRows[count-1].dataY+40);
  assert.ok(g.plotBottom>g.plotTop);
 }
});
test('one-point survival curve remains finite at every display detail',async()=>{
 const {curvePoints,stepPath}=await moduleAt('plot.js');
 const curve={timeline:[0],survival:[0],lower:[0],upper:[0]};
 for(const detail of [.5,.95,1]){
  const points=curvePoints(curve,detail);assert.equal(points.length,1);
  assert.ok(!/NaN|undefined/.test(stepPath(points,x=>x,y=>y)));
 }
});

test('automatic subgroup names update values/ranges and preserve owner overrides',async()=>{
 const {groupName,autoName}=await moduleAt('group-names.js');
 assert.equal(groupName('TREATMENT','tags',{values:['A','B']}),'TREATMENT: A+B');
 assert.equal(groupName('ERBB2','ranges',{lo:-3.2,hi:0}),'ERBB2: -3.2 to 0');
 assert.equal(autoName('ERBB2','ranges',{lo:0,hi:3,name:'Custom',customName:true}).name,'Custom');
 const {figureGeometry}=await moduleAt('figure.js');
 const g=figureGeometry({curves:[{label:'A very long first variable range with a second variable and full cohort description'}],side:true,showAtRisk:true,showMedians:true});
 assert.ok(g.legendEntries[0].height>g.legendEntries[0].lines.length*13+17);
 assert.ok(g.riskRows[0].lines.join(' ').includes('full cohort description'));
});
