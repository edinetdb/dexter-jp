import { guardInput } from './input-guard.js';
import { findVocabularyHits, INPUT_LISTS } from './vocabulary.js';
import h3 from './__fixtures__/heldout3-inputs.json';
let caught = 0, vocabOnly = 0; const missed: string[] = [];
for (const { persona, text } of h3.advice_seeking) {
  const v = await guardInput(text, { interactive: true });
  if (v.decision === 'refuse') caught++; else missed.push(`[${persona}] ${text}`);
  if (findVocabularyHits(text, INPUT_LISTS).length > 0) vocabOnly++;
}
let fp = 0; const fps: string[] = [];
for (const { persona, text } of h3.legitimate) {
  const v = await guardInput(text, { interactive: true });
  if (v.decision === 'refuse') { fp++; fps.push(`[${persona}] ${text} <<${v.by}: ${JSON.stringify(v.hits.map(h=>h.term))}${JSON.stringify(v.intentHits?.map(h=>h.matched) ?? [])}>>`); }
}
console.log('held-out #3（固定評価集合・調整に一度も使っていない）');
console.log(`  助言 recall（2 層）  = ${caught}/${h3.advice_seeking.length}`);
console.log(`  参考: 語彙リスト単独 = ${vocabOnly}/${h3.advice_seeking.length}`);
console.log(`  対照群の誤検知       = ${fp}/${h3.legitimate.length}`);
console.log('  --- 取りこぼし ---'); missed.forEach(m => console.log('   ', m));
console.log('  --- 誤検知 ---'); fps.forEach(m => console.log('   ', m));
