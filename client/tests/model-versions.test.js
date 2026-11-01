import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionedModelManifest } from '../dev/model-versions.js';

test('only changed model content gets a new version, without a manual revision bump',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mars-model-versions-'));
 try {
   await writeFile(join(directory,'manifest.json'),JSON.stringify({approved:['drill','rover'],revision:'same'}));
   await writeFile(join(directory,'drill.glb'),'drill-v1');await writeFile(join(directory,'rover.glb'),'rover-v1');
   const first=await versionedModelManifest(directory);
   assert.deepEqual(await versionedModelManifest(directory),first);
   await writeFile(join(directory,'drill.glb'),'drill-v2');
   const next=await versionedModelManifest(directory);
   assert.notEqual(first.versions.drill,next.versions.drill);
   assert.equal(first.versions.rover,next.versions.rover);
 }finally{await rm(directory,{recursive:true,force:true});}
});
