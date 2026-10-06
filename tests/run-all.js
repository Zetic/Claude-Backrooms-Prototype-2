// No dependencies or build step. Fail immediately on any canonical regression.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
for(const seed of [31337,7,12345,99,4242])for(const suite of ['determinism','circulation']){
  console.log(`\n=== ${suite}: seed ${seed} ===`);
  const result=spawnSync(process.execPath,[path.join(__dirname,suite+'.test.js'),String(seed)],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
console.log('\nAll 10 canonical suite runs passed.');
