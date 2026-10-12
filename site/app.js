/* Page logic. All data is written with textContent, never as HTML. */
(function () {
  'use strict';

  const S = window.StarSearch;
  const $ = (id) => document.getElementById(id);
  const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

  const state = {
    repos: [], meta: null, glossary: {}, groups: null, query: '', permissiveOnly: false,
    ignored: [], dropped: [],
  };
  const el = {
    app: $('app'), form: $('search-form'), q: $('q'), examples: $('examples'), results: $('results'),
    chips: $('chips'), addForm: $('add-form'), addInput: $('add-input'), permissive: $('permissive'),
    interpret: $('notice-interpret'), notes: $('notes'), summary: $('summary'), message: $('message'), list: $('list'),
    smallBox: $('small-box'), smallList: $('small-list'), error: $('error'), meta: $('meta'),
  };

  // ----------------------------------------------------------------- helpers
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  function relativeDays(days) {
    if (days >= 9999) return '푸시 기록 없음';
    if (days < 1) return '오늘 푸시';
    if (days < 31) return days + '일 전 푸시';
    if (days < 365) return Math.floor(days / 30) + '개월 전 푸시';
    return Math.floor(days / 365) + '년 전 푸시';
  }

  function termsToString(groups) {
    return groups.map((g) => g.join('|')).join(',');
  }

  function updateUrl() {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.groups && state.groups.length) params.set('g', termsToString(state.groups));
    if (state.permissiveOnly) params.set('p', '1');
    const qs = params.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
  }

  // ------------------------------------------------------------------ render
  function renderCard(repo) {
    const li = make('li', 'card');
    const head = make('div', 'card-head');
    if (FULL_NAME.test(repo.full_name)) {
      const a = make('a', 'name', repo.full_name);
      a.href = 'https://github.com/' + repo.full_name;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      head.appendChild(a);
    } else {
      head.appendChild(make('span', 'name', repo.full_name));
    }
    const badge = S.licenseBadge(repo.license);
    const b = make('span', 'badge ' + badge.tone, badge.text);
    if (badge.note) b.title = badge.note;
    head.appendChild(b);
    li.appendChild(head);

    li.appendChild(make('p', 'desc', repo.description || '설명 없음'));

    const facts = ['스타 ' + repo.stars.toLocaleString('en-US'), relativeDays(repo.days)];
    if (repo.language) facts.push(repo.language);
    if (repo.why.length) facts.push('일치: ' + repo.why.map(S.whyLabel).join(', '));
    if (badge.short) facts.push(badge.short);
    li.appendChild(make('p', 'facts', facts.join(' · ')));
    return li;
  }

  function renderChips() {
    el.chips.textContent = '';
    state.groups.forEach((g, i) => {
      const li = make('li', 'chip');
      li.title = g.join(' | ');
      li.appendChild(make('span', null, g[0]));
      const x = make('button', null, '×');
      x.type = 'button';
      x.setAttribute('aria-label', '검색어 ' + g[0] + ' 삭제');
      x.addEventListener('click', () => {
        state.groups.splice(i, 1);
        render();
      });
      li.appendChild(x);
      el.chips.appendChild(li);
    });
  }

  /** What the search left out, so a word never disappears without a trace. */
  function renderNotes(unmatched) {
    const lines = [];
    if (state.ignored.length) {
      lines.push('해석하지 못한 한국어: ' + state.ignored.join(', ') + ' (영어 단어로 추가하면 검색에 쓰입니다)');
    }
    if (state.dropped.length) {
      lines.push('검색어는 ' + S.MAX_GROUPS + '개까지 쓰므로 뺀 것: ' + state.dropped.map((g) => g[0]).join(', '));
    }
    if (unmatched.length) {
      lines.push('스타 목록 어디에도 없어 점수에서 뺀 단어: ' + unmatched.map((g) => g[0]).join(', '));
    }
    el.notes.textContent = lines.join(' · ');
    el.notes.hidden = !lines.length;
  }

  function render() {
    updateUrl();
    el.app.classList.toggle('home', !state.groups);
    el.results.hidden = !state.groups;
    if (!state.groups) return;

    renderChips();
    el.interpret.textContent = '간이 해석으로 검색했습니다. 한국어 용어집에 있는 단어와 영어 단어만 이해합니다.';
    el.list.textContent = '';
    el.smallList.textContent = '';
    el.message.hidden = true;
    el.smallBox.hidden = true;

    if (!state.groups.length) {
      renderNotes([]);
      el.summary.textContent = '';
      el.message.textContent = '검색어가 없습니다. 아래 입력칸에 영어 단어를 추가해 주세요. 예: korea, law';
      el.message.hidden = false;
      return;
    }

    const r = S.runSearch(state.repos, state.groups, { permissiveOnly: state.permissiveOnly, now: new Date() });
    renderNotes(r.unmatched);
    el.summary.textContent = '스타 ' + r.poolSize + '개 중 관련 후보 ' + r.shown + '개'
      + (r.shown > r.main.length ? ' (상위 ' + r.main.length + '개 표시)' : '');

    if (r.empty) {
      const words = state.groups.map((g) => g[0]).join(', ');
      let text = '검색어 [' + words + ']에 일치하는 저장소가 없습니다. 칩을 지우거나 다른 영어 단어를 추가해 보세요.';
      if (r.hiddenByLicense > 0) {
        text = '허용형 라이선스가 아닌 저장소 ' + r.hiddenByLicense + '개가 숨겨져 있습니다. 위의 필터를 끄면 보입니다.';
      }
      el.message.textContent = text;
      el.message.hidden = false;
      return;
    }
    r.main.forEach((repo) => el.list.appendChild(renderCard(repo)));
    if (r.small.length) {
      r.small.forEach((repo) => el.smallList.appendChild(renderCard(repo)));
      el.smallBox.hidden = false;
    }
  }

  // ------------------------------------------------------------------ actions
  function search(text) {
    const query = text.trim();
    showError('');
    if (!query) {
      showError('검색어를 입력해 주세요.');
      return;
    }
    if (query.length > S.MAX_QUERY_LENGTH) {
      showError('검색어는 ' + S.MAX_QUERY_LENGTH + '자까지 입력할 수 있습니다.');
      return;
    }
    try {
      const r = S.interpretPurpose(query, state.glossary);
      state.groups = r.groups;
      state.ignored = r.ignored;
      state.dropped = r.dropped;
      state.query = query;
      el.q.value = query;
      render();
    } catch (e) {
      if (!(e instanceof S.QueryError)) throw e;
      state.groups = null;
      state.query = '';
      state.ignored = [];
      state.dropped = [];
      render();
      const unknown = e.message.includes('Not understood') ? ' 알아듣지 못한 단어: ' + e.message.split('Not understood: ')[1] + '.' : '';
      showError('용어집에 있는 단어도 영어 단어도 찾지 못했습니다.' + unknown + ' 영어 키워드를 함께 적어 보세요. 예: korea labor law');
    }
  }

  function addTerms(text) {
    showError('');
    try {
      const merged = S.mergeGroups(state.groups, S.parseTermsArg(text));
      state.groups = merged.groups;
      state.dropped = merged.dropped;
      el.addInput.value = '';
      render();
    } catch (e) {
      if (!(e instanceof S.QueryError)) throw e;
      showError(e.code === 'non_ascii' ? '검색어 추가는 영어로 적어 주세요.' : '추가할 단어를 입력해 주세요.');
    }
  }

  function bind() {
    el.form.addEventListener('submit', (ev) => { ev.preventDefault(); search(el.q.value); });
    el.addForm.addEventListener('submit', (ev) => { ev.preventDefault(); addTerms(el.addInput.value); });
    el.permissive.addEventListener('change', () => { state.permissiveOnly = el.permissive.checked; render(); });
    el.examples.querySelectorAll('button[data-q]').forEach((btn) => {
      btn.addEventListener('click', () => search(btn.dataset.q));
    });
  }

  function showMeta() {
    const m = state.meta;
    const date = (m.generated_at || '').slice(0, 10);
    const ageDays = Math.floor((Date.now() - Date.parse(m.generated_at)) / 86400000);
    let text = m.user + '의 스타 ' + m.count + '개 · 마지막 갱신 ' + date;
    if (ageDays > 3) text += ' (갱신이 ' + ageDays + '일 전에 멈춰 있습니다)';
    el.meta.textContent = text;
  }

  function restoreFromUrl() {
    const params = new URLSearchParams(location.search);
    state.permissiveOnly = params.get('p') === '1';
    el.permissive.checked = state.permissiveOnly;
    const q = params.get('q') || '';
    const g = params.get('g');
    if (g) {
      try {
        state.groups = S.parseTermsArg(g);
        state.query = q;
        el.q.value = q;
        render();
        return;
      } catch (e) { /* fall through to the text query */ }
    }
    if (q) search(q);
  }

  async function boot() {
    try {
      const [stars, glossary] = await Promise.all([
        fetch('stars.json').then((r) => { if (!r.ok) throw new Error('stars.json ' + r.status); return r.json(); }),
        fetch('glossary.json').then((r) => { if (!r.ok) throw new Error('glossary.json ' + r.status); return r.json(); }),
      ]);
      state.meta = stars;
      state.repos = stars.repos;
      state.glossary = S.parseGlossary(glossary);
    } catch (e) {
      showError(location.protocol === 'file:'
        ? '파일로 직접 열면 데이터를 불러올 수 없습니다. 웹 서버로 열어 주세요. (python -m http.server)'
        : '저장소 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      el.form.querySelector('button').disabled = true;
      return;
    }
    showMeta();
    bind();
    restoreFromUrl();
  }

  boot();
})();
