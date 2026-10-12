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
