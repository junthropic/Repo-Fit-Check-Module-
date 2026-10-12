/* Query handling and ranking for the star search site.
 *
 * This is a port of the ranking part of repo-fit-check/scripts/discover.py. The two must
 * behave the same: tests/test_parity.py runs both on the same data and compares the output.
 * If you change a rule here, change it in discover.py too (and the other way round).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StarSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Filler words of English sentences. Identical to STOPWORDS in discover.py.
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'my', 'our', 'tool', 'tools',
    'that', 'this', 'using', 'use', 'app', 'project',
    'i', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'can', 'could', 'would', 'should', 'will',
    'shall', 'may', 'might', 'must', 'do', 'does', 'did', 'you', 'your', 'yours', 'me', 'we', 'us', 'it', 'its',
    'they', 'them', 'their', 'he', 'she', 'his', 'her', 'find', 'finding', 'looking', 'look', 'help', 'helps',
    'want', 'wants', 'need', 'needs', 'good', 'best', 'better', 'some', 'any', 'something', 'anything',
    'please', 'like', 'how', 'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'get', 'gets', 'make',
    'makes', 'have', 'has', 'had', 'into', 'from', 'by', 'at', 'as', 'about', 'than', 'then', 'so', 'if', 'not',
    'no', 'but', 'all', 'more', 'most', 'very', 'also', 'just', 'there', 'here', 'used', 'one', 'own', 'up',
    'out', 'over', 'too', 'such', 'these', 'those', 'other', 'another',
  ]);
  const GENERIC = new Set(['platform', 'system', 'service', 'program', 'software', 'solution', 'application',
    'management']);
  const SINGLE_LETTER_OK = new Set(['c', 'r']); // language names; any other one-letter word is noise
  const FIELD_WEIGHT = [['name', 1.0], ['topics', 0.9], ['description', 0.7]];
  const PERMISSIVE = new Set(['MIT', 'MIT-0', 'APACHE-2.0', 'BSD-3-CLAUSE', 'BSD-2-CLAUSE', 'BSD-1-CLAUSE', 'ISC', 'UNLICENSE',
    'CC0-1.0', '0BSD', 'BSL-1.0', 'ZLIB', 'UNICODE-3.0']);
  const MIN_REL = 0.34;
  const MAX_GROUPS = 6;
  const MAX_QUERY_LENGTH = 200;

  // One definition of "blank", identical to SPACE in discover.py. String.trim() and Python's strip()
  // disagree on U+001C-001F, U+0085 and U+FEFF, which made the two implementations rank differently.
  const SPACE_RANGES = [[0x0, 0x20], [0x7f, 0xa0], [0x1680], [0x180e], [0x2000, 0x200b], [0x2028], [0x2029],
    [0x202f], [0x205f], [0x3000], [0xfeff]];
  const SPACE = new RegExp('[' + SPACE_RANGES
    .map((r) => r.map((c) => String.fromCharCode(c)).join('-')).join('') + ']+', 'g');
  // English word as a visitor writes it: 3D, C#, C++, node.js, open-source; no trailing punctuation.
  const TERM_SOURCE = '[A-Za-z0-9][A-Za-z0-9+#]*(?:[-.][A-Za-z0-9+#]+)*';
  // GitHub's timestamp format. Anything else counts as "no push date", never as an error.
  const ISO_Z = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;

  class QueryError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const round3 = (x) => Number(x.toFixed(3));

  // ------------------------------------------------------------------ terms
  function hasNonAscii(text) {
    return /[^\x00-\x7f]/.test(text);
  }

  function normalizeSpace(text) {
    return String(text == null ? '' : text).replace(SPACE, ' ').replace(/^ +| +$/g, '');
  }

  function parseGlossary(raw) {
    const out = {};
    Object.keys(raw || {}).forEach((k) => {
      if (!k.startsWith('_')) out[k] = raw[k];
    });
    return out;
  }

  /** Drop repeated words inside a group and groups with the same word set (they would count twice). */
  function dedupeGroups(groups) {
    const seen = new Set();
    const out = [];
    groups.forEach((g0) => {
      const g = Array.from(new Set(g0));
      const key = JSON.stringify(g.slice().sort());
      if (!seen.has(key)) {
        seen.add(key);
        out.push(g);
      }
    });
    return out;
  }

  function finish(groups0, ignored) {
    const groups = dedupeGroups(groups0);
    const bad = groups.flat().filter(hasNonAscii);
    if (bad.length) {
      throw new QueryError('non_ascii', 'Non-English terms need translation: ' + bad.join(', '));
    }
    if (!groups.length) {
      throw new QueryError('no_terms', 'No usable search terms.' + (ignored.length ? ' Not understood: ' + ignored.join(', ') : ''));
    }
    return { groups: groups.slice(0, MAX_GROUPS), dropped: groups.slice(MAX_GROUPS), ignored };
  }

  /** Explicit terms, e.g. "labor|employment, law|statute, compliance" (what the chips hold). */
  function interpretTerms(arg) {
    const groups = [];
    normalizeSpace(arg).split(',').forEach((part) => {
      const words = part.split('|').map((w) => w.replace(/^ +| +$/g, '').toLowerCase()).filter(Boolean);
      if (words.length) groups.push(words);
    });
    return finish(groups, []);
  }

  /** Free text. Korean words the glossary knows become English synonym groups; English words pass through.
   *  Returns {groups, dropped (cut because only MAX_GROUPS are used), ignored (Korean words not understood)}. */
  function interpretPurpose(text0, glossary) {
    const text = normalizeSpace(text0);
    const used = [];
    const found = [];
    Object.entries(glossary || {})
      .sort((a, b) => b[0].length - a[0].length)
      .forEach(([ko, en]) => {
        if (text.includes(ko) && !used.some((u) => ko.includes(u) || u.includes(ko))) {
          used.push(ko);
          // an empty value means "ignore this word" (방법 must not trigger 법)
          if (en) found.push([text.indexOf(ko), en.split('|').map((w) => w.toLowerCase())]);
        }
      });
    const re = new RegExp(TERM_SOURCE, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const w = m[0].toLowerCase();
      if (STOPWORDS.has(w) || /^[0-9]+$/.test(w) || (w.length < 2 && !SINGLE_LETTER_OK.has(w))) continue;
      if (!found.some(([, g]) => g.includes(w))) found.push([m.index, [w]]);
    }
    const groups = found
      .sort((a, b) => a[0] - b[0])
      .map(([, g]) => g)
      .filter((g) => !g.every((w) => GENERIC.has(w)));
    let rest = text;
    used.forEach((ko) => { rest = rest.split(ko).join(' '); });
    rest = rest.replace(new RegExp(TERM_SOURCE, 'g'), ' ');
    const ignored = [];
    (rest.match(/\p{L}+/gu) || []).forEach((w) => {
      if (w.length >= 2 && !ignored.includes(w)) ignored.push(w);
    });
    return finish(groups, ignored);
  }

  const parseTermsArg = (arg) => interpretTerms(arg).groups;
  const parsePurpose = (text, glossary) => interpretPurpose(text, glossary).groups;

  /** Chips added by the visitor: merge, keep at most MAX_GROUPS. A new chip whose words are all already
   *  in an existing chip (typing "law" next to "law|statute|legal") adds nothing and is skipped. */
  function mergeGroups(existing, added) {
    const all = dedupeGroups(existing).slice();
    dedupeGroups(added).forEach((g) => {
      if (!all.some((e) => g.every((w) => e.includes(w)))) all.push(g);
    });
    return { groups: all.slice(0, MAX_GROUPS), dropped: all.slice(MAX_GROUPS) };
  }

  // ---------------------------------------------------------------- scoring
  function tokens(text) {
    return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  }

  function wordIn(word, toks) {
    const parts = String(word).toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!parts.length) return false;
    // singular <- plural only for longer words: 'as'->'a', 'its'->'it', 'news'->'new' are not plurals
    const has = (p) => toks.has(p) || toks.has(p + 's') || (p.length >= 5 && p.endsWith('s') && toks.has(p.slice(0, -1)));
    return parts.every(has);
  }

  function groupScores(repo, groups) {
    const parts = repo.full_name.split('/');
    const nameToks = new Set([...tokens(parts[parts.length - 1]), ...tokens(parts[0])]);
    const fields = {
      name: nameToks,
      topics: tokens((repo.topics || []).join(' ')),
      description: tokens(repo.description),
    };
    const scores = [];
    const wheres = [];
    groups.forEach((g) => {
      let best = 0;
      let where = null;
      FIELD_WEIGHT.forEach(([fname, weight]) => {
        if (weight > best && g.some((w) => wordIn(w, fields[fname]))) {
          best = weight;
          where = fname;
        }
      });
      scores.push(best);
      wheres.push(where);
    });
    return { scores, wheres };
  }

  function documentFrequencies(repos, groups) {
    const df = groups.map(() => 0);
    repos.forEach((r) => {
      groupScores(r, groups).scores.forEach((s, i) => {
        if (s > 0) df[i] += 1;
      });
    });
    return df;
  }

  /** Rarer term groups in the pool discriminate more ('korea' over 'compliance').
   *  A group no repository matches gets weight 0, so an absent filler word cannot become the most important one. */
  function idfWeights(repos, groups) {
    const n = repos.length;
    if (n < 10) return groups.map(() => 1.0);
    return documentFrequencies(repos, groups).map((d) => (d > 0 ? Math.log(1 + n / (d + 1)) : 0.0));
  }

  /** Groups that no repository in the (live) pool matches; they were left out of the scoring. */
  function unmatchedGroups(repos, groups) {
    const live = repos.filter((r) => !(r.archived || r.fork));
    if (live.length < 10) return [];
    return documentFrequencies(live, groups).map((d, i) => (d === 0 ? groups[i] : null)).filter(Boolean);
  }

  function relevance(repo, groups, weights) {
    const { scores, wheres } = groupScores(repo, groups);
    const w = weights || groups.map(() => 1.0);
    let num = 0;
    let den = 0;
    scores.forEach((s, i) => {
      num += w[i] * s;
      den += w[i];
    });
    let rel = den > 0 ? num / den : 0.0;
    const active = scores.filter((s, i) => w[i] > 0);
    if (active.length && active.every((s) => s > 0)) rel = Math.min(1.0, rel + 0.1);
    const why = [];
    groups.forEach((g, i) => {
      if (wheres[i]) why.push(g[0] + '<-' + wheres[i]);
    });
    return { rel, why };
  }

  /** Days since the push. A date that is not GitHub's YYYY-MM-DDTHH:MM:SSZ counts as "no date". */
  function daysSince(iso, now) {
    const m = typeof iso === 'string' ? ISO_Z.exec(iso) : null;
    if (!m) return 9999;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    if (y < 1970 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return 9999;
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
    if (d > daysInMonth) return 9999;
    const ms = Date.UTC(y, mo - 1, d, h, mi, s);
    return Math.max(0, Math.floor((now.getTime() - ms) / 86400000));
  }

  function activity(days) {
    return days <= 30 ? 1.0 : days <= 90 ? 0.8 : days <= 180 ? 0.5 : days <= 365 ? 0.2 : 0.0;
  }

  function licenseStatus(spdx, allowed, avoid) {
    const s = (spdx || '').toUpperCase();
    if (s && avoid.some((a) => s.includes(a.toUpperCase()))) return 'blocked';
    if (!s || s === 'NOASSERTION' || s === 'OTHER') return 'unknown';
    if (allowed.length && !allowed.some((a) => a.toUpperCase() === s)) return 'mismatch';
    return 'ok';
  }

  function scoreRepo(repo, groups, allowed, avoid, now, weights) {
    const { rel, why } = relevance(repo, groups, weights);
    const days = daysSince(repo.pushed_at, now);
    const pop = Math.min(1.0, Math.log10(repo.stars + 1) / 5);
    const lic = licenseStatus(repo.license, allowed, avoid);
    const licScore = { ok: 1.0, unknown: 0.5, mismatch: 0.0, blocked: 0.0 }[lic];
    let final = 0.70 * rel + 0.10 * pop + 0.15 * activity(days) + 0.05 * licScore;
    if (lic === 'mismatch') final *= 0.6;
    return Object.assign({}, repo, {
      rel: round3(rel), pop: round3(pop), days, lic_status: lic, score: round3(final), why,
    });
  }

  function rank(repos, groups, opts) {
    const o = Object.assign({ allowed: [], avoid: [], minRel: 0.0, now: new Date() }, opts);
    const live = repos.filter((r) => !(r.archived || r.fork));
    const weights = idfWeights(live, groups);
    const seen = new Set();
    const scored = [];
    const excluded = [];
    repos.forEach((r) => {
      if (!r.full_name || seen.has(r.full_name)) return;
      seen.add(r.full_name);
      if (r.archived || r.fork) {
        excluded.push([r.full_name, 'archived/fork']);
        return;
      }
      const s = scoreRepo(r, groups, o.allowed, o.avoid, o.now, weights);
      if (s.lic_status === 'blocked') {
        excluded.push([r.full_name, 'license ' + r.license + ' is in avoid']);
        return;
      }
      if (s.rel >= o.minRel) scored.push(s);
    });
    scored.sort((a, b) => (b.score - a.score) || (b.stars - a.stars));
    return { scored, excluded };
  }

  /** Top by score, then relevant small repos separately so big ones cannot crowd them out. */
  function select(scored, opts) {
    const o = Object.assign({ top: 10, smallPicks: 5, smallStars: 500, smallMinRel: 0.5 }, opts);
    const main = scored.slice(0, o.top);
    const names = new Set(main.map((r) => r.full_name));
    const small = scored
      .filter((r) => r.stars < o.smallStars && r.rel >= o.smallMinRel && !names.has(r.full_name))
      .slice(0, o.smallPicks);
    return { main, small };
  }

  function isPermissive(spdx) {
    return PERMISSIVE.has((spdx || '').toUpperCase());
  }

  /** One search: rank the whole pool, optionally keep only permissive licenses, then select. */
  function runSearch(repos, groups, opts) {
    const o = Object.assign({ permissiveOnly: false, now: new Date(), top: 10, minRel: MIN_REL }, opts);
    const { scored, excluded } = rank(repos, groups, { minRel: o.minRel, now: o.now });
    const visible = o.permissiveOnly ? scored.filter((r) => isPermissive(r.license)) : scored;
    const { main, small } = select(visible, { top: o.top });
    return {
      groups, main, small,
      poolSize: repos.length, kept: scored.length, shown: visible.length,
      excludedCount: excluded.length, hiddenByLicense: scored.length - visible.length,
      unmatched: unmatchedGroups(repos, groups),
      empty: main.length === 0,
    };
  }

  /** Every result row carries one of these. Not detected and unidentified licenses are warnings.
   *  `note` is the tooltip, `short` the words shown on the row. Neither claims more than GitHub told us:
   *  NOASSERTION usually means a LICENSE file exists that GitHub could not match to a standard license. */
  function licenseBadge(spdx) {
    const s = (spdx || '').toUpperCase();
    if (!s) {
      return {
        text: '라이선스 미감지', tone: 'warn', short: '라이선스 직접 확인',
        note: 'GitHub이 라이선스 파일을 찾지 못했습니다. 명시된 라이선스가 없으면 기본적으로 사용 허락이 없는 것으로 봅니다',
      };
    }
    if (s === 'NOASSERTION' || s === 'OTHER') {
      return {
        text: '라이선스 불명', tone: 'warn', short: '라이선스 직접 확인',
        note: 'LICENSE 파일이 있어도 GitHub이 표준 라이선스로 식별하지 못했습니다. 파일을 직접 확인하세요',
      };
    }
    if (PERMISSIVE.has(s)) return { text: spdx, tone: 'ok', short: '', note: '' };
    return { text: spdx, tone: 'info', short: '사용 조건 확인', note: '사용 조건을 확인하세요' };
  }

  const FIELD_LABEL = { name: '이름', topics: '토픽', description: '설명' };

  /** "korea<-name" -> "이름에서 korea" */
  function whyLabel(item) {
    const [word, field] = item.split('<-');
    return (FIELD_LABEL[field] || field) + '에서 ' + word;
  }

  return {
    QueryError, STOPWORDS, GENERIC, SINGLE_LETTER_OK, PERMISSIVE, MIN_REL, MAX_GROUPS, MAX_QUERY_LENGTH,
    parseGlossary, normalizeSpace, dedupeGroups, interpretTerms, interpretPurpose, parseTermsArg, parsePurpose,
    mergeGroups,
    tokens, wordIn, groupScores, documentFrequencies, idfWeights, unmatchedGroups, relevance, daysSince, activity,
    licenseStatus, scoreRepo, rank, select, runSearch, isPermissive, licenseBadge, whyLabel,
  };
});
