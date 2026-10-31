import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const local=root+(process.platform==='win32'?'.venv-world/Scripts/python.exe':'.venv-world/bin/python');
const python=process.env.WORLD_PYTHON || (existsSync(local)?local:process.platform==='win32'?'python':'python3');
execFileSync(python,[root+'tools/generate_world.py'],{cwd:root,stdio:'inherit'});
