// Unit tests for site/search.js. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../site/search.js');

const glossary = S.parseGlossary(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'glossary.json'), 'utf8')));
const NOW = new Date('2026-10-12T00:00:00Z');
const repo = (name, over) => Object.assign({
  full_name: name, description: '', stars: 10, pushed_at: '2026-10-01T00:00:00Z', license: 'MIT',
  archived: false, fork: false, language: null, topics: [],
}, over);

test('AC-7: every license state has a badge; none and unknown are warnings', () => {
  assert.deepStrictEqual(S.licenseBadge(null).tone, 'warn');
  assert.strictEqual(S.licenseBadge(null).text, '라이선스 없음');
  assert.strictEqual(S.licenseBadge('').tone, 'warn');
  assert.strictEqual(S.licenseBadge('NOASSERTION').text, '라이선스 불명');
  assert.strictEqual(S.licenseBadge('NOASSERTION').tone, 'warn');
  assert.strictEqual(S.licenseBadge('OTHER').tone, 'warn');
  assert.strictEqual(S.licenseBadge('MIT').tone, 'ok');
  assert.strictEqual(S.licenseBadge('mit').tone, 'ok');
  assert.strictEqual(S.licenseBadge('AGPL-3.0').tone, 'info');
  assert.match(S.licenseBadge('AGPL-3.0').note, /조건/);
  assert.match(S.licenseBadge(null).note, /사용 권한 없음/);
});

test('AC-2: no match gives an explicit empty result, with the terms that were used', () => {
  const repos = [repo('a/pdf-tool', { description: 'pdf' }), repo('b/other')];
  const r = S.runSearch(repos, [['zzzz']], { now: NOW });
  assert.strictEqual(r.empty, true);
  assert.deepStrictEqual(r.groups, [['zzzz']]);
  assert.strictEqual(r.poolSize, 2);
});

test('license filter keeps the order and reports what it hid', () => {
  const repos = [
    repo('a/labor-law', { license: 'GPL-3.0', description: 'labor law compliance', stars: 900 }),
    repo('b/labor-law-tool', { license: 'MIT', description: 'labor law compliance', stars: 50 }),
    repo('c/labor-law-kit', { license: null, description: 'labor law compliance', stars: 40 }),
    repo('d/labor-law-lib', { license: 'Apache-2.0', description: 'labor law compliance', stars: 30 }),
  ];
  const groups = [['labor'], ['law'], ['compliance']];
  const all = S.runSearch(repos, groups, { now: NOW });
  const only = S.runSearch(repos, groups, { now: NOW, permissiveOnly: true });
  assert.strictEqual(all.main.length, 4);
  assert.deepStrictEqual(only.main.map((r) => r.full_name), all.main.map((r) => r.full_name).filter((n) => ['b/labor-law-tool', 'd/labor-law-lib'].includes(n)));
  assert.strictEqual(only.hiddenByLicense, 2);
});

test('AC-8: re-ranking after a chip edit is fast on a real-size pool', () => {
  const repos = Array.from({ length: 2000 }, (_, i) => repo('o' + (i % 50) + '/repo-' + i, {
    description: 'tool number ' + i + (i % 7 === 0 ? ' korea law' : ''), topics: i % 5 === 0 ? ['labor'] : [],
  }));
  const t0 = process.hrtime.bigint();
  S.runSearch(repos, [['korea'], ['law'], ['labor']], { now: NOW });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, 'took ' + ms + ' ms');
});

test('Korean text maps through the glossary; unknown Korean fails loudly', () => {
  const g = S.parsePurpose('한국 노동법 준수를 점검하는 도구 찾고 있어', glossary);
  const flat = g.flat();
  ['korea', 'labor', 'compliance'].forEach((w) => assert.ok(flat.includes(w), w));
  assert.throws(() => S.parsePurpose('가나다라마바사', glossary), (e) => e instanceof S.QueryError && e.code === 'no_terms');
  assert.throws(() => S.parseTermsArg('노동, law'), (e) => e instanceof S.QueryError && e.code === 'non_ascii');
  assert.throws(() => S.parseTermsArg('  ,  '), (e) => e.code === 'no_terms');
});

test('"법" inside a compound gives a law term; words that merely contain it do not', () => {
  const flat = (text) => S.parsePurpose(text, glossary).flat();
  assert.ok(flat('한국 노동법 준수를 점검하는 도구 찾고 있어').includes('law'));
  ['문서 작성 방법 pdf', 'pdf 사용법', '법인 회계', '영어 문법 pdf'].forEach((t) => {
    const w = flat(t);
    assert.ok(!w.includes('law') && !w.includes('statute'), t + ' -> ' + w);
  });
  assert.ok(flat('법인 회계').includes('corporation'));
  assert.ok(flat('불법 scraper').includes('illegal'));
  assert.throws(() => S.parsePurpose('방법', glossary), (e) => e.code === 'no_terms');
});

test('English words pass through; stopwords and generic words are dropped', () => {
  const g = S.parsePurpose('pdf translation tool for the platform', glossary);
  assert.deepStrictEqual(g, [['pdf'], ['translation']]);
});

test('terms syntax: commas split groups, bars list synonyms, at most six groups', () => {
  assert.deepStrictEqual(S.parseTermsArg('Labor|Employment, law'), [['labor', 'employment'], ['law']]);
  assert.strictEqual(S.parseTermsArg('a,b,c,d,e,f,g,h').length, 6);
});

test('archived and forked repositories never appear', () => {
  const repos = [repo('a/labor', { archived: true, description: 'labor' }), repo('b/labor', { fork: true, description: 'labor' }),
    repo('c/labor', { description: 'labor' })];
  const r = S.runSearch(repos, [['labor']], { now: NOW });
  assert.deepStrictEqual(r.main.map((x) => x.full_name), ['c/labor']);
});

test('matched fields are labelled in Korean', () => {
  assert.strictEqual(S.whyLabel('korea<-name'), '이름에서 korea');
  assert.strictEqual(S.whyLabel('law<-topics'), '토픽에서 law');
  assert.strictEqual(S.whyLabel('law<-description'), '설명에서 law');
});

test('query length limit is 200', () => {
  assert.strictEqual(S.MAX_QUERY_LENGTH, 200);
});

// ---- sentence handling (bundle 1 of the audit) ----------------------------------------------
const words = (text) => S.interpretPurpose(text, glossary).groups.map((g) => g[0]);

test('English filler does not use up the term slots', () => {
  assert.deepStrictEqual(words('I am looking for a tool that can help me translate PDF documents into Korean'),
    ['translate', 'pdf', 'documents', 'korean']);
  assert.deepStrictEqual(words('Can you find me a good MCP server for searching the web?'), ['mcp', 'server', 'searching', 'web']);
});

test('groups beyond the limit are reported, not silently cut', () => {
  const r = S.interpretPurpose('alpha beta gamma delta epsilon zeta eta theta', glossary);
  assert.strictEqual(r.groups.length, S.MAX_GROUPS);
  assert.deepStrictEqual(r.dropped.map((g) => g[0]), ['eta', 'theta']);
});

test('Korean the glossary does not know is listed as ignored', () => {
  assert.deepStrictEqual(S.interpretPurpose('pdf 렌더링', glossary).ignored, ['렌더링']);
  assert.deepStrictEqual(S.interpretPurpose('PDF 번역 도구', glossary).ignored, []); // 도구 is filler, 번역 is known
  assert.throws(() => S.interpretPurpose('노무현 연설문', glossary), (e) => e.code === 'no_terms' && /Not understood/.test(e.message));
});

test('digits, symbols and trailing punctuation in English terms', () => {
  assert.deepStrictEqual(words('3D printing'), ['3d', 'printing']);
  assert.deepStrictEqual(words('C# parser'), ['c#', 'parser']);
  assert.deepStrictEqual(words('R language'), ['r', 'language']);
  assert.deepStrictEqual(words('node.js library'), ['node.js', 'library']);
  assert.deepStrictEqual(words('law. labor.'), ['law', 'labor']);
  assert.deepStrictEqual(words('year 2024 report'), ['year', 'report']);
});

test('repeated groups count once; chips added later are merged, deduplicated and capped', () => {
  assert.deepStrictEqual(S.parseTermsArg('law|law, law'), [['law']]);
  const merged = S.mergeGroups([['a'], ['b'], ['c'], ['d'], ['e']], S.parseTermsArg('x,y,z,a'));
  assert.strictEqual(merged.groups.length, S.MAX_GROUPS);
  assert.deepStrictEqual(merged.dropped.map((g) => g[0]), ['y', 'z']);
  assert.deepStrictEqual(S.mergeGroups([['law']], [['law']]).groups, [['law']]);
  // a chip whose words all sit in an existing chip adds nothing; a chip with a new word is kept
  assert.deepStrictEqual(S.mergeGroups([['law', 'statute', 'legal']], [['law']]).groups, [['law', 'statute', 'legal']]);
  assert.deepStrictEqual(S.mergeGroups([['law', 'statute']], [['law', 'regulation']]).groups, [['law', 'statute'], ['law', 'regulation']]);
});

test('blank characters are handled like discover.py does', () => {
  [0x1c, 0x85, 0xfeff, 0xa0, 0x3000].forEach((code) => {
    assert.deepStrictEqual(S.parseTermsArg('law,' + String.fromCharCode(code)), [['law']], code.toString(16));
  });
});

test('short words do not match by stripping an s', () => {
  assert.strictEqual(S.wordIn('as', new Set(['a'])), false);
  assert.strictEqual(S.wordIn('its', new Set(['it'])), false);
  assert.strictEqual(S.wordIn('news', new Set(['new'])), false);
  assert.strictEqual(S.wordIn('ios', new Set(['io'])), false);
  assert.strictEqual(S.wordIn('tools', new Set(['tool'])), true);
  assert.strictEqual(S.wordIn('pdf', new Set(['pdfs'])), true);
});

test('a word no repository has is reported and does not decide the result', () => {
  const pool = Array.from({ length: 12 }, (_, i) => repo('o/pdf-' + i, { stars: 10 + i, description: 'pdf translation', topics: ['pdf'] }));
  const base = S.runSearch(pool, [['pdf'], ['translation']], { now: NOW });
  const withAbsent = S.runSearch(pool, [['pdf'], ['translation'], ['xyzzy']], { now: NOW });
  assert.strictEqual(withAbsent.shown, base.shown);
  assert.deepStrictEqual(withAbsent.main.map((r) => r.rel), base.main.map((r) => r.rel));
  assert.deepStrictEqual(withAbsent.unmatched, [['xyzzy']]);
  assert.deepStrictEqual(base.unmatched, []);
});

test('only GitHub timestamps count as dates; the rest means "no date", never NaN', () => {
  assert.strictEqual(S.daysSince('2026-10-01T00:00:00Z', NOW), 11);
  ['2026-10-01', '2026-10-01T00:00:00', 'bad', '2026-13-45T00:00:00Z', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z',
    '2026-10-01T00:00:60Z', '0001-01-01T00:00:00Z', '2026-10-01T00:00:00Z\n', '', null, undefined].forEach((v) => {
    assert.strictEqual(S.daysSince(v, NOW), 9999, String(v));
  });
  assert.strictEqual(S.daysSince('2099-01-01T00:00:00Z', NOW), 0);
  assert.strictEqual(S.daysSince('2024-02-29T12:00:00Z', NOW) > 0, true); // a real leap day is valid
});
