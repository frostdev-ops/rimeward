import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
await build({ absWorkingDir:root,entryPoints:['workers/knowledge.mjs'],outfile:'workers/knowledge.bundle.mjs',
  bundle:true,platform:'node',format:'esm',packages:'external',target:'node22' });
