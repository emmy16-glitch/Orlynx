import { writeFile } from 'node:fs/promises';
const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
const catalog = (await response.json()).opencode;
if (!catalog?.models || !Object.keys(catalog.models).length) throw new Error('Empty OpenCode catalog');
await writeFile(new URL('../apps/api/src/opencode-models.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Updated ${Object.keys(catalog.models).length} OpenCode models. Review and commit this snapshot.`);
