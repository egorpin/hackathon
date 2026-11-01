import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function versionedModelManifest(directory) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const versions = {};
  for (const name of manifest.approved || []) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid approved model name');
    versions[name] = createHash('sha256').update(await readFile(resolve(directory, name + '.glb'))).digest('hex');
  }
  return { ...manifest, versions };
}

export function modelVersions() {
  let config;
  return {
    name: 'model-content-versions',
    configResolved(value) { config = value; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/assets/models/manifest.json') return next();
        try {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify(await versionedModelManifest(resolve(config.publicDir, 'assets/models'))));
        } catch (error) { next(error); }
      });
    },
    async writeBundle() {
      const directory = resolve(config.root, config.build.outDir, 'assets/models');
      await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(await versionedModelManifest(directory)));
    },
  };
}
