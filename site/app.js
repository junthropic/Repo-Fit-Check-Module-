/* Page logic. All data is written with textContent, never as HTML. */
(function () {
  'use strict';

  const S = window.StarSearch;
  const $ = (id) => document.getElementById(id);
  const FULL_NAME = /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/;
  const PAGE = 10; // results shown at first, and added by each "more"
  const MAX_G_PARAM = 400; // a shared link may carry at most this many characters of search terms
  const MAX_WORDS_PER_GROUP = 8;

  const state = {
    repos: [], meta: null, glossary: {}, groups: null, query: '', permissiveOnly: false,
    ignored: [], dropped: [], omitted: [], limit: PAGE,
  };
  const el = {
    app: $('app'), form: $('search-form'), q: $('q'), examples: $('examples'), results: $('results'),
    chips: $('chips'), addForm: $('add-form'), addInput: $('add-input'), permissive: $('permissive'),
    interpret: $('notice-interpret'), notes: $('notes'), summary: $('summary'), status: $('status'),
    message: $('message'), list: $('list'), more: $('more'),
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

  /** Ranking uses the time of the snapshot, not the visitor's clock, so one link shows one result everywhere. */
  function rankingTime() {
    const t = Date.parse(state.meta && state.meta.generated_at);
    return Number.isNaN(t) ? new Date() : new Date(t);
  }

  function termsToString(groups) {
    return groups.map((g) => g.join('|')).join(',');
  }

  function updateUrl(push) {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.groups && state.groups.length) params.set('g', termsToString(state.groups));
    if (state.permissiveOnly) params.set('p', '1');
    const qs = params.toString();
    const url = qs ? '?' + qs : location.pathname;
    const unchanged = qs === location.search.replace(/^[?]/, '');
    if (push && !unchanged) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
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
      a.appendChild(make('span', 'sr-only', ' (새 탭에서 열림)'));
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

  /** A chip shows every synonym, so keyboard and touch users see what it stands for (not only a tooltip). */
  function renderChips() {
    el.chips.textContent = '';
    state.groups.forEach((g, i) => {
      const li = make('li', 'chip');
      li.appendChild(make('span', null, g.join(' | ')));
      const x = make('button', null, '×');
      x.type = 'button';
      x.setAttribute('aria-label', '검색어 ' + g.join(' 또는 ') + ' 삭제');
      x.addEventListener('click', () => {
        state.groups.splice(i, 1);
        state.limit = PAGE;
        render({ focusChip: i });
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
    if (state.omitted.length) {
      lines.push('군더더기로 보고 뺀 영어 단어: ' + state.omitted.join(', ') + ' (필요하면 영어 단어로 추가하세요)');
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

  function focusAfterChipRemoval(index) {
    const buttons = el.chips.querySelectorAll('button');
    if (buttons.length) buttons[Math.min(index, buttons.length - 1)].focus();
    else el.addInput.focus();
  }

  /** The one place screen readers hear about a new result: a short summary, not the whole list. */
  function announce(text) {
    el.status.textContent = text;
  }

  function render(opts) {
    const o = opts || {};
    updateUrl(Boolean(o.push));
    el.app.classList.toggle('home', !state.groups);
    el.results.hidden = !state.groups;
    if (!state.groups) {
      announce('');
      return;
    }

    renderChips();
    el.interpret.textContent = '간이 해석으로 검색했습니다. 한국어 용어집에 있는 단어와 영어 단어만 이해합니다.';
    const before = o.keepList ? el.list.children.length : 0;
    el.list.textContent = '';
    el.smallList.textContent = '';
    el.message.hidden = true;
    el.smallBox.hidden = true;
    el.more.hidden = true;

    if (!state.groups.length) {
      renderNotes([]);
      el.summary.textContent = '';
      el.message.textContent = '검색어가 없습니다. 아래 입력칸에 영어 단어를 추가해 주세요. 예: korea, law';
      el.message.hidden = false;
      announce(el.message.textContent);
      if (o.focusChip !== undefined) focusAfterChipRemoval(o.focusChip);
      return;
    }

    const r = S.runSearch(state.repos, state.groups, {
      permissiveOnly: state.permissiveOnly, now: rankingTime(), top: state.limit,
    });
    renderNotes(r.unmatched);
    el.summary.textContent = '스타 ' + r.poolSize + '개 중 관련 후보 ' + r.shown + '개'
      + (r.shown > r.main.length ? ' (상위 ' + r.main.length + '개 표시)' : '');
    announce(el.summary.textContent);

    if (r.empty) {
      const words = state.groups.map((g) => g[0]).join(', ');
      let text = '검색어 [' + words + ']에 일치하는 저장소가 없습니다. 칩을 지우거나 다른 영어 단어를 추가해 보세요.';
      if (r.hiddenByLicense > 0) {
        text = '허용형 라이선스가 아닌 저장소 ' + r.hiddenByLicense + '개가 숨겨져 있습니다. 위의 필터를 끄면 보입니다.';
      }
      el.message.textContent = text;
      el.message.hidden = false;
      announce(text);
    } else {
      r.main.forEach((repo) => el.list.appendChild(renderCard(repo)));
      el.more.hidden = r.shown <= r.main.length;
      if (!el.more.hidden) el.more.textContent = '더 보기 (' + (r.shown - r.main.length) + '개 남음)';
      if (r.small.length) {
        r.small.forEach((repo) => el.smallList.appendChild(renderCard(repo)));
        el.smallBox.hidden = false;
      }
    }
    if (o.focusChip !== undefined) focusAfterChipRemoval(o.focusChip);
    if (o.keepList && el.list.children[before]) {
      const first = el.list.children[before].querySelector('a');
      if (first) first.focus();
    }
  }

  // ------------------------------------------------------------------ actions
  function search(text, push) {
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
    state.limit = PAGE;
    try {
      const r = S.interpretPurpose(query, state.glossary);
      state.groups = r.groups;
      state.ignored = r.ignored;
      state.dropped = r.dropped;
      state.omitted = r.omitted;
      state.query = query;
      el.q.value = query;
      render({ push });
    } catch (e) {
      if (!(e instanceof S.QueryError)) throw e;
      state.groups = null;
      state.query = '';
      state.ignored = [];
      state.dropped = [];
      state.omitted = [];
      render({ push: false });
      const unknown = e.message.includes('Not understood') ? ' 알아듣지 못한 단어: ' + e.message.split('Not understood: ')[1] + '.' : '';
      showError('용어집에 있는 단어도 영어 단어도 찾지 못했습니다.' + unknown + ' 영어 키워드를 함께 적어 보세요. 예: korea labor law');
    }
  }

  function addTerms(text) {
    showError('');
    try {
      const merged = S.mergeGroups(state.groups, S.parseTermsArg(text));
      if (merged.groups.length === state.groups.length && !merged.dropped.length) {
        showError('이미 있는 검색어입니다.');
        return;
      }
      const known = new Set(state.dropped.map((g) => g.join('|')));
      state.groups = merged.groups;
      state.dropped = state.dropped.concat(merged.dropped.filter((g) => !known.has(g.join('|'))));
      state.limit = PAGE;
      el.addInput.value = '';
      render();
    } catch (e) {
      if (!(e instanceof S.QueryError)) throw e;
      showError(e.code === 'non_ascii' ? '검색어 추가는 영어로 적어 주세요.' : '추가할 단어를 입력해 주세요.');
    }
  }

  function bind() {
    el.form.addEventListener('submit', (ev) => { ev.preventDefault(); search(el.q.value, true); });
    el.addForm.addEventListener('submit', (ev) => { ev.preventDefault(); addTerms(el.addInput.value); });
    el.permissive.addEventListener('change', () => {
      state.permissiveOnly = el.permissive.checked;
      state.limit = PAGE;
      render();
    });
    el.more.addEventListener('click', () => {
      state.limit += PAGE;
      render({ keepList: true });
    });
    el.examples.querySelectorAll('button[data-q]').forEach((btn) => {
      btn.addEventListener('click', () => search(btn.dataset.q, true));
    });
    window.addEventListener('popstate', restoreFromUrl); // the back button returns to the previous search
  }

  function showMeta() {
    const m = state.meta;
    const t = Date.parse(m.generated_at);
    let text = m.user + '의 스타 ' + m.count + '개';
    if (Number.isNaN(t)) {
      text += ' · 마지막 갱신 날짜를 알 수 없음';
    } else {
      text += ' · 마지막 갱신 ' + m.generated_at.slice(0, 10);
      const ageDays = Math.floor((Date.now() - t) / 86400000);
      if (ageDays > 3) text += ' (갱신이 ' + ageDays + '일 전에 멈춰 있습니다)';
    }
    el.meta.textContent = text;
  }

  /** A shared link must not be able to freeze the tab: bounded length, bounded synonyms per group. */
  function groupsFromParam(g) {
    if (!g || g.length > MAX_G_PARAM) return null;
    try {
      return S.parseTermsArg(g).map((group) => group.slice(0, MAX_WORDS_PER_GROUP));
    } catch (e) {
      return null;
    }
  }

  function restoreFromUrl() {
    const params = new URLSearchParams(location.search);
    state.permissiveOnly = params.get('p') === '1';
    el.permissive.checked = state.permissiveOnly;
    state.limit = PAGE;
    showError('');
    const q = params.get('q') || '';
    const groups = groupsFromParam(params.get('g'));
    if (groups) {
      state.groups = groups;
      state.query = q.slice(0, S.MAX_QUERY_LENGTH);
      state.ignored = [];
      state.dropped = [];
      state.omitted = [];
      try {
        const r = S.interpretPurpose(state.query, state.glossary);
        state.ignored = r.ignored;
        state.omitted = r.omitted;
      } catch (e) { /* the chips in g are what counts */ }
      el.q.value = state.query;
      render();
      return;
    }
    if (q) {
      search(q, false);
      return;
    }
    state.groups = null;
    state.query = '';
    el.q.value = '';
    render();
  }

  /** The data file is read defensively: a damaged entry is skipped instead of breaking the page. */
  function cleanRepos(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((r) => r && typeof r.full_name === 'string' && FULL_NAME.test(r.full_name)).map((r) => ({
      full_name: r.full_name,
      description: typeof r.description === 'string' ? r.description : '',
      stars: Number.isFinite(r.stars) ? r.stars : 0,
      pushed_at: typeof r.pushed_at === 'string' ? r.pushed_at : null,
      license: typeof r.license === 'string' ? r.license : null,
      archived: Boolean(r.archived),
      fork: Boolean(r.fork),
      language: typeof r.language === 'string' ? r.language : null,
      topics: Array.isArray(r.topics) ? r.topics.filter((t) => typeof t === 'string') : [],
    }));
  }

  function failBoot(message) {
    showError(message);
    el.form.querySelector('button').disabled = true;
    el.examples.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  }

  async function boot() {
    let stars;
    let glossary;
    try {
      [stars, glossary] = await Promise.all([
        fetch('stars.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('stars.json ' + r.status); return r.json(); }),
        fetch('glossary.json').then((r) => { if (!r.ok) throw new Error('glossary.json ' + r.status); return r.json(); }),
      ]);
    } catch (e) {
      failBoot(location.protocol === 'file:'
        ? '파일로 직접 열면 데이터를 불러올 수 없습니다. 웹 서버로 열어 주세요. (python -m http.server)'
        : '저장소 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    const repos = cleanRepos(stars && stars.repos);
    if (!repos.length) {
      failBoot('저장소 목록이 비어 있거나 형식이 올바르지 않습니다. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    state.meta = { user: String(stars.user || ''), count: repos.length, generated_at: String(stars.generated_at || '') };
    state.repos = repos;
    state.glossary = S.parseGlossary(glossary);
    showMeta();
    bind();
    restoreFromUrl();
  }

  boot();
})();
