// Knowledge base search. BM25 ranking over chunks, with light prefix-stemming so
// Ukrainian/Russian/English word forms match ("доставка" / "доставки" / "доставку").
// Production swap: OpenAI embeddings + pgvector, same search() signature.

const STOP = new Set(('a an and are as at be but by can do does for from have how i if in is it me my of on or our so that the this to was we what when where which who why will with you your ' +
  'і й та що як це не на в у з до за по від для чи а але же ли ти ви ми я є бо то так '+
  'и что как это не на в у с до за по от для или а но же ли ты вы мы я есть то так ' +
  // question filler: carries intent, not topic, so it shouldn't count against a match
  'price prices cost costs much many does there please tell want need could would much ' +
  'скільки коштує коштують ціна ціни вартість який яка яке які можна підкажіть скажіть хочу треба є ' +
  'сколько стоит стоят цена цены стоимость какой какая какое какие можно подскажите скажите хочу нужно есть').split(' '));

export function terms(text) {
  const words = String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter(w => w.length > 1 && !STOP.has(w)).map(w => (w.length >= 6 ? w.slice(0, 5) : w));
}

// Paragraph-aware chunks of ~800 characters.
export function chunk(text, max = 800) {
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const out = []; let cur = '';
  for (const p of paras) {
    if (p.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      for (const s of p.split(/(?<=[.!?])\s+/)) {
        if ((cur + ' ' + s).length > max && cur) { out.push(cur); cur = ''; }
        cur = cur ? `${cur} ${s}` : s;
      }
      continue;
    }
    if ((cur + '\n\n' + p).length > max && cur) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

// chunks: [{ content, terms: string[], ...meta }]. Returns the top k with score and coverage
// (share of distinct query terms found in the chunk).
export function search(chunks, query, k = 4) {
  const q = [...new Set(terms(query))];
  if (!q.length || !chunks.length) return [];
  const N = chunks.length, avg = chunks.reduce((s, c) => s + c.terms.length, 0) / N || 1;
  const df = Object.fromEntries(q.map(t => [t, chunks.filter(c => c.terms.includes(t)).length]));
  const k1 = 1.2, b = 0.75;
  return chunks.map(c => {
    let score = 0, hit = 0;
    for (const t of q) {
      const f = c.terms.filter(x => x === t).length;
      if (!f) continue;
      hit++;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.terms.length / avg));
    }
    return { ...c, score, coverage: hit / q.length };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
