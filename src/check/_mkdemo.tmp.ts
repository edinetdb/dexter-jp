import { segmentIntoParagraphs, mergeNearDuplicateParagraphs } from './core/index.js';
const KEY = process.env.EDINETDB_API_KEY!;
const CODE = 'E02144';
const h = { 'X-API-Key': KEY };
const tb = await (await fetch(`https://edinetdb.jp/v1/companies/${CODE}/text-blocks?full=true`, { headers: h })).json() as any;
const ev = await (await fetch(`https://edinetdb.jp/v1/events?edinet_code=${CODE}&event_type=yuhou&since=2025-01-01&limit=5`, { headers: h })).json() as any;
const co = await (await fetch(`https://edinetdb.jp/v1/companies/${CODE}`, { headers: h })).json() as any;
if (tb.meta?.truncated) throw new Error('要約版が返っている');
const d = co.data ?? co;
const docId = (ev.data ?? []).filter((e:any)=>e.event_type==='yuhou').sort((a:any,b:any)=>String(b.event_date).localeCompare(String(a.event_date)))[0]?.source_id;
const MAP: Record<string,string> = { 'mda':'経営者による分析', 'risks':'事業等のリスク' };
const bySection = new Map((tb.data as any[]).map(s => [s.section, s.text]));
const all: any[] = [];
for (const [key, jp] of Object.entries(MAP)) {
  const text = bySection.get(jp);
  if (!text) continue;
  const ps = segmentIntoParagraphs(text, {
    docId, company: d.name_ja ?? d.name, edinetCode: CODE, filer: d.name_ja ?? d.name,
    docType: '有価証券報告書', section: key, fiscalYear: d.latest_fiscal_year,
  });
  all.push(...ps.map(p => ({ ...p, id: `${key}-${p.id}`, sectionName: jp })));
}
const deduped = mergeNearDuplicateParagraphs(all);
console.log(`全 ${deduped.length} 段落（mda + risks）`);
await Bun.write('/Users/rikukoike/Desktop/tmp/dexter-kotae/demo/all-paragraphs.json',
  JSON.stringify({ company: { name: d.name_ja ?? d.name, edinetCode: CODE, secCode: d.sec_code },
                   fiscalYear: d.latest_fiscal_year, docId, paragraphs: deduped }, null, 2));
// 為替に触れる段落を探す（デモの仮説に使う）
const hits = deduped.filter(p => /為替/.test(p.text)).slice(0, 8);
console.log(`「為替」を含む段落 ${deduped.filter(p=>/為替/.test(p.text)).length} 本。先頭 3 本:`);
for (const p of hits.slice(0,3)) console.log(` [${p.section}] ${p.text.slice(0,110)}…`);
