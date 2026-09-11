// Run with an isolated HOMEPAGE_DATA_DIR containing both verified Qwen downloads,
// RIMEWARD_DESKTOP=1 and the native runtime token. No cloud calls or source writes.
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { embed } from '../src/lib/agent/embeddings.ts';
import { embeddingProfile, DEFAULT_EMBEDDING, LOCAL_MODELS } from '../src/lib/agent/embedding-profiles.ts';
import { localEmbeddingStatus, refreshEmbeddingMemory, unloadEmbeddingModel, shutdownEmbeddings } from '../src/lib/agent/embedding-local.ts';
const [corpusFile,output] = process.argv.slice(2);
if (!corpusFile || !output) throw Error('Usage: node ops/embedding-benchmark.mjs corpus.json report.json');
const raw = fs.readFileSync(corpusFile,'utf8'), corpus = JSON.parse(raw);
if (!Array.isArray(corpus.documents) || !Array.isArray(corpus.queries) || !corpus.documents.length || !corpus.queries.length
  || corpus.documents.some(d => typeof d.id !== 'string' || typeof d.text !== 'string') || corpus.queries.some(q => typeof q.text !== 'string' || !Array.isArray(q.relevant))) throw Error('Corpus needs documents [{id,text}] and queries [{text,relevant:[document ids]}].');
const report = { corpusSha256:createHash('sha256').update(raw).digest('hex'),platform:process.platform,arch:process.arch,
  totalMemoryBytes:os.totalmem(),documents:corpus.documents.length,queries:corpus.queries.length,profiles:[] };
try {
  for (const quantization of ['Q4_K_M','Q8_0']) {
    await unloadEmbeddingModel(); const config = { ...DEFAULT_EMBEDDING,quantization }, profile = embeddingProfile(config);
    const available = await refreshEmbeddingMemory(), installed = localEmbeddingStatus().models.find(m => m.quantization === quantization)?.installed;
    if (!installed) {
      report.profiles.push({ profile:profile.id,status:'not-run',availableMemoryBytes:available,modelInstalled:installed,
        reason:'Verified model not installed. No accuracy or latency claim is made.' }); continue;
    }
    const documents = [], started = performance.now();
    for (let i = 0; i < corpus.documents.length; i += 8) documents.push(...await embed(1,corpus.documents.slice(i,i+8).map(d => d.text),false,undefined,config));
    const indexingMs = performance.now()-started, results = [];
    for (const q of corpus.queries) {
      const begin = performance.now(), [vector] = await embed(1,[q.text],true,undefined,config), queryMs = performance.now()-begin;
      const ranking = documents.map((d,i) => ({ id:corpus.documents[i].id,score:d.reduce((s,v,j) => s+v*vector[j],0) })).sort((a,b) => b.score-a.score);
      results.push({ query:q.text,queryMs,ranking,recallAt5:q.relevant.filter(id => ranking.slice(0,5).some(r => r.id === id)).length/Math.max(1,q.relevant.length),
        reciprocalRank:ranking.some(r => q.relevant.includes(r.id)) ? 1/(ranking.findIndex(r => q.relevant.includes(r.id))+1) : 0 });
    }
    const measured = localEmbeddingStatus();
    report.profiles.push({ profile:profile.id,status:'measured',availableMemoryBytes:available,memoryAdvisory:available !== null && available < LOCAL_MODELS[quantization].memoryGB * 1024 ** 3,
      indexingMs,documentsPerSecond:1000*documents.length/indexingMs,
      runtime:{ startupMs:measured.startupMs,queryMs:measured.queryMs,peakMemoryBytes:measured.peakMemoryBytes,memoryMeasurement:'Process RSS sampled at 1 Hz; not total unified GPU memory.' },
      recallAt5:results.reduce((n,r) => n+r.recallAt5,0)/results.length,results });
  }
  const measured = report.profiles.filter(p => p.status === 'measured');
  if (measured.length === 2) report.rankingDifferences = measured[0].results.map((r,i) => ({ query:r.query,
    changed:r.ranking.map(v => v.id).join('\n') !== measured[1].results[i].ranking.map(v => v.id).join('\n') }));
  fs.writeFileSync(output,`${JSON.stringify(report,null,2)}\n`);
  console.log(`Benchmark report written to ${output}; ${measured.length}/2 profiles measured.`);
} finally { await shutdownEmbeddings(); }
