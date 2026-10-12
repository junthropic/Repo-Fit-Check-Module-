// Behaviour tests for site/app.js, run against a minimal fake DOM (no browser, no dependencies).
// They cover what static checks cannot: shared links, focus, paging, damaged data, the back button.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = path.join(__dirname, '..', 'site');
const S = require(path.join(SITE, 'search.js'));
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
const glossary = JSON.parse(fs.readFileSync(path.join(SITE, 'glossary.json'), 'utf8'));

class El {
  constructor(tag, id) {
    Object.assign(this, {
      tagName: tag, id, children: [], _text: '', hidden: false, className: '', value: '', disabled: false,
      attrs: {}, listeners: {}, dataset: {}, type: '', title: '', href: '', target: '', rel: '', checked: false,
    });
    this.classList = { toggle: (c, on) => { this.classes = this.classes || new Set(); (on ? this.classes.add(c) : this.classes.delete(c)); } };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t) { (this.listeners[t] || []).forEach((f) => f({ preventDefault() {} })); }
  focus() { this.doc.active = this; }
  descendants(pred) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (pred(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    if (sel === 'button') return this.descendants((c) => c.tagName === 'button');
    if (sel === 'button[data-q]') return this.descendants((c) => c.tagName === 'button' && c.dataset.q);
    throw new Error('selector not supported: ' + sel);
  }
  querySelector(sel) {
    const found = sel === 'button' ? this.querySelectorAll('button') : this.descendants((c) => c.tagName === sel);
    return found[0] || null;
  }
}

/** Boots app.js with the given stars.json content and URL query string. Returns handles to inspect. */
async function boot({ stars, search = '', fetchFails = false, protocol = 'http:', clockMs }) {
  const doc = { active: null, byId: {} };
  [...html.matchAll(/id="([^"]+)"/g)].forEach((m) => {
    const tag = ['search-form', 'add-form'].includes(m[1]) ? 'form' : ['more', 'permissive'].includes(m[1]) ? 'button' : 'div';
    const e = new El(tag, m[1]);
    e.doc = doc;
    doc.byId[m[1]] = e;
  });
  const submitButton = new El('button', 'submit');
  submitButton.doc = doc;
  doc.byId['search-form'].appendChild(submitButton);
  ['한국 노동법 준수를 점검하는 도구 찾고 있어', 'pdf translation'].forEach((q) => {
    const b = new El('button', '');
    b.doc = doc;
    b.dataset.q = q;
    doc.byId.examples.appendChild(b);
  });
  doc.getElementById = (id) => doc.byId[id];
  doc.createElement = (tag) => { const e = new El(tag, ''); e.doc = doc; return e; };

  const location = { search, pathname: '/', protocol };
  const history = {
    calls: [],
    pushState(_s, _t, url) { this.calls.push(['push', url]); location.search = url.startsWith('?') ? url : ''; },
    replaceState(_s, _t, url) { this.calls.push(['replace', url]); location.search = url.startsWith('?') ? url : ''; },
  };
  const windowListeners = {};
  const window = { StarSearch: S, addEventListener: (t, f) => { windowListeners[t] = f; } };
  const fetch = async (url) => {
    if (fetchFails) throw new Error('offline');
    const body = url === 'stars.json' ? stars : glossary;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  // the page's idea of 'now' is injectable, so a test can give the visitor a wrong clock
  const baseNow = clockMs === undefined ? Date.now() : clockMs;
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(baseNow); else super(...a); }
    static now() { return baseNow; }
  }
  const sandbox = { window, document: doc, location, history, fetch, URLSearchParams, Date: FakeDate, Number, Math, String, Array, Boolean, Promise, JSON };
  vm.runInNewContext(appSource, vm.createContext(sandbox));
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  const $ = (id) => doc.byId[id];
  return {
    $, doc, location, history, popstate: () => windowListeners.popstate && windowListeners.popstate(),
    cards: () => $('list').children,
    chipWords: () => $('chips').children.map((li) => li.children[0].textContent),
    submit: (text) => { $('q').value = text; $('search-form').dispatch('submit'); },
  };
}

const repo = (name, over) => Object.assign({
  full_name: name, description: '', stars: 10, pushed_at: '2026-10-01T00:00:00Z', license: 'MIT',
  archived: false, fork: false, language: null, topics: [],
}, over);
const snapshot = (repos, extra) => Object.assign({ generated_at: '2026-10-12T00:00:00Z', user: 'tester', count: repos.length, repos }, extra);
const pdfPool = (n) => Array.from({ length: n }, (_, i) => repo('o/pdf-tool-' + i, { description: 'pdf translation', stars: 1000 - i, topics: ['pdf'] }));

test('a sentence is searched and the first screen turns into the result screen', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  assert.strictEqual(app.$('results').hidden, true);
  app.submit('I am looking for a tool that can help me translate PDF documents');
  assert.strictEqual(app.$('results').hidden, false);
  assert.deepStrictEqual(app.chipWords(), ['translate', 'pdf', 'documents']);
  assert.ok(app.cards().length > 0);
  assert.match(app.$('meta').textContent, /tester의 스타 12개 · 마지막 갱신 2026-10-12/);
});

test('a new search pushes a history entry; chip edits only replace it; the back button restores the search', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('pdf translation');
  assert.strictEqual(app.history.calls.at(-1)[0], 'push');
  app.$('chips').children[0].children[1].listeners.click[0]();   // remove the first chip
  assert.strictEqual(app.history.calls.at(-1)[0], 'replace');
  app.location.search = '?q=pdf+translation&g=pdf,translation';
  app.popstate();
  assert.deepStrictEqual(app.chipWords(), ['pdf', 'translation']);
});

test('a shared link cannot freeze the tab: long g is ignored, synonyms per group are capped', async () => {
  const long = 'a|' + Array.from({ length: 200 }, (_, i) => 'w' + i).join('|');
  const app = await boot({ stars: snapshot(pdfPool(12)), search: '?q=pdf+translation&g=' + encodeURIComponent(long) });
  assert.deepStrictEqual(app.chipWords(), ['pdf', 'translation']); // fell back to the text query
  const ok = await boot({ stars: snapshot(pdfPool(12)), search: '?g=' + encodeURIComponent('law|' + Array.from({ length: 12 }, (_, i) => 'x' + i).join('|')) });
  assert.strictEqual(ok.chipWords()[0].split(' | ').length, 8);
});

test('removing a chip keeps the focus in the chip list; removing the last one moves it to the input', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('pdf translation documents');
  const removeAt = (i) => app.$('chips').children[i].children[1].listeners.click[0]();
  removeAt(1);
  assert.strictEqual(app.doc.active, app.$('chips').children[1].children[1]);
  removeAt(1);
  removeAt(0);
  assert.strictEqual(app.doc.active, app.$('add-input'));
});

test('"more" shows ten more, keeps the list and focuses the first new result', async () => {
  const app = await boot({ stars: snapshot(pdfPool(25)) });
  app.submit('pdf translation');
  assert.strictEqual(app.cards().length, 10);
  assert.strictEqual(app.$('more').hidden, false);
  assert.match(app.$('more').textContent, /15개 남음/);
  app.$('more').dispatch('click');
  assert.strictEqual(app.cards().length, 20);
  assert.strictEqual(app.doc.active, app.cards()[10].children[0].children[0]); // the link of result number 11
  app.$('more').dispatch('click');
  assert.strictEqual(app.cards().length, 25);
  assert.strictEqual(app.$('more').hidden, true);
});

test('screen readers get a short summary in the status region, not the whole list', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('pdf translation');
  assert.strictEqual(app.$('status').textContent, app.$('summary').textContent);
  assert.ok(!/pdf-tool/.test(app.$('status').textContent));
});

test('ranking uses the snapshot time: the same link shows the same result whatever the visitor clock says', async () => {
  // old repo has more stars but is stale; with the snapshot clock the recent one wins on activity
  const stars = snapshot([repo('o/pdf-old', { description: 'pdf translation', pushed_at: '2026-04-01T00:00:00Z', stars: 900 }),
    repo('o/pdf-new', { description: 'pdf translation', pushed_at: '2026-10-10T00:00:00Z', stars: 100 })]);
  const names = async (clockMs) => {
    const a = await boot({ stars, clockMs });
    a.submit('pdf translation');
    return a.cards().map((c) => c.children[0].children[0].textContent.replace(' (새 탭에서 열림)', ''));
  };
  const onTime = await names(Date.parse('2026-10-12T12:00:00Z'));
  assert.deepStrictEqual(onTime.slice(0, 2), ['o/pdf-new', 'o/pdf-old']);
  const yearAhead = await names(Date.parse('2027-11-20T00:00:00Z')); // a visitor whose clock is far ahead
  assert.deepStrictEqual(yearAhead, onTime);
});

test('damaged entries are skipped, and a list with nothing usable is reported instead of searched', async () => {
  const junk = [null, 5, {}, { full_name: 42 }, { full_name: 'no slash' }, { full_name: 'a/<script>' }];
  const mixed = await boot({ stars: snapshot([...junk, repo('o/pdf-ok', { description: 'pdf translation' })]) });
  mixed.submit('pdf');
  assert.strictEqual(mixed.cards().length, 1);
  assert.match(mixed.$('meta').textContent, /스타 1개/);
  const none = await boot({ stars: snapshot(junk) });
  assert.strictEqual(none.$('error').hidden, false);
  assert.match(none.$('error').textContent, /비어 있거나/);
  assert.strictEqual(none.$('search-form').children[0].disabled, true);
  const notAList = await boot({ stars: { generated_at: 'x', user: 'u', repos: 'oops' } });
  assert.strictEqual(notAList.$('error').hidden, false);
});

test('when the data cannot be loaded the search and the examples are disabled and say why', async () => {
  const app = await boot({ stars: snapshot([]), fetchFails: true });
  assert.strictEqual(app.$('error').hidden, false);
  assert.match(app.$('error').textContent, /불러오지 못했습니다/);
  assert.strictEqual(app.$('search-form').children[0].disabled, true);
  assert.ok(app.$('examples').children.every((b) => b.disabled));
  const file = await boot({ stars: snapshot([]), fetchFails: true, protocol: 'file:' });
  assert.match(file.$('error').textContent, /웹 서버로 열어/);
});

test('a missing or broken generated_at is shown as unknown, not as NaN', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12), { generated_at: 'garbage' }) });
  assert.match(app.$('meta').textContent, /날짜를 알 수 없음/);
  assert.ok(!/NaN/.test(app.$('meta').textContent));
  app.submit('pdf translation');
  assert.ok(app.cards().length > 0);
});

test('empty or too long input is refused with a message, nothing is searched', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('   ');
  assert.strictEqual(app.$('error').hidden, false);
  assert.strictEqual(app.$('results').hidden, true);
  app.submit('x'.repeat(201));
  assert.match(app.$('error').textContent, /200자/);
});

test('every result link goes to github.com, opens safely and says it opens a new tab', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('pdf translation');
  const link = app.cards()[0].children[0].children[0];
  assert.match(link.href, /^https:\/\/github\.com\/o\/pdf-tool-/);
  assert.strictEqual(link.rel, 'noopener noreferrer');
  assert.match(link.textContent, /새 탭에서 열림/);
});

test('a sentence tells which filler it removed, so no word vanishes unnoticed', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('help desk software');
  assert.match(app.$('notes').textContent, /군더더기로 보고 뺀 영어 단어: help, software/);
  assert.strictEqual(app.$('notes').hidden, false);
});

test('a link opened again still shows the words the sentence left out', async () => {
  const q = encodeURIComponent('pdf 렌더링');
  const app = await boot({ stars: snapshot(pdfPool(12)), search: '?q=' + q + '&g=pdf' });
  assert.match(app.$('notes').textContent, /해석하지 못한 한국어: 렌더링/);
});

test('chips added later never make the words cut earlier disappear from the note', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('alpha beta gamma delta epsilon zeta eta theta');
  assert.match(app.$('notes').textContent, /eta, theta/);
  app.$('add-input').value = 'kappa';
  app.$('add-form').dispatch('submit');
  assert.match(app.$('notes').textContent, /eta, theta, kappa/);
});

test('adding a word that is already a chip says so and changes nothing', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('pdf translation');
  app.$('add-input').value = 'pdf';
  app.$('add-form').dispatch('submit');
  assert.deepStrictEqual(app.chipWords(), ['pdf', 'translation']);
  assert.match(app.$('error').textContent, /이미 있는 검색어/);
});

test('the same search twice leaves one history entry, and a failed search leaves none', async () => {
  const app = await boot({ stars: snapshot(pdfPool(12)) });
  app.submit('pdf translation');
  app.submit('pdf translation');
  const pushes = () => app.history.calls.filter((c) => c[0] === 'push').length;
  assert.strictEqual(pushes(), 1);
  app.submit('가나다라마바사');
  assert.strictEqual(pushes(), 1);
});
