import {readFile,readdir,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'tools/licenses/npm');await mkdir(out,{recursive:true});
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const seen=new Set(),index=[];
async function collect(name) {
  if(seen.has(name))return;seen.add(name);
  const dir=join(root,'node_modules',name);
  let dependency;try{dependency=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));}catch{return;}
  const licenses=(await readdir(dir)).filter(file=>/^(license|copying|notice)(\.|$)/i.test(file));
  for(const file of licenses)await copyFile(join(dir,file),join(out,`${name.replace(/[/@]/g,'_')}-${file}`));
  index.push({name,version:dependency.version,license:dependency.license,files:licenses});
  for(const child of Object.keys(dependency.dependencies||{}))await collect(child);
}
for(const name of Object.keys(pkg.dependencies))await collect(name);
await writeFile(join(out,'index.json'),JSON.stringify(index,null,2));
console.log(`Collected license metadata for ${index.length} frontend runtime packages.`);
