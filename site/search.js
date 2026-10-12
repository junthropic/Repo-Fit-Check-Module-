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

  const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'my', 'our',
    'tool', 'tools', 'that', 'this', 'using', 'use', 'app', 'project']);
  const GENERIC = new Set(['platform', 'system', 'service', 'program', 'software', 'solution', 'application',
    'management']);
  const FIELD_WEIGHT = [['name', 1.0], ['topics', 0.9], ['description', 0.7]];
  const PERMISSIVE = new Set(['MIT', 'APACHE-2.0', 'BSD-3-CLAUSE', 'BSD-2-CLAUSE', 'ISC', 'UNLICENSE', 'CC0-1.0', '0BSD']);
  const MIN_REL = 0.34;
  const MAX_GROUPS = 6;
  const MAX_QUERY_LENGTH = 200;

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

  function parseGlossary(raw) {
    const out = {};
    Object.keys(raw || {}).forEach((k) => {
      if (!k.startsWith('_')) out[k] = raw[k];
    });
    return out;
  }

  function finishGroups(groups) {
    const bad = groups.flat().filter(hasNonAscii);
    if (bad.length) {
      throw new QueryError('non_ascii', 'Non-English terms need translation: ' + bad.join(', '));
    }
    if (!groups.length) {
      throw new QueryError('no_terms', 'No usable search terms.');
    }
    return groups.slice(0, MAX_GROUPS);
  }

  /** Explicit terms, e.g. "labor|employment, law|statute, compliance" (what the chips hold). */
  function parseTermsArg(arg) {
    const groups = [];
    String(arg || '').split(',').forEach((part) => {
      const words = part.split('|').map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (words.length) groups.push(words);
    });
    return finishGroups(groups);
  }

  /** Free text. Korean words the glossary knows become English synonym groups; English words pass through. */
  function parsePurpose(text, glossary) {
    const purpose = String(text || '');
    const used = [];
    const found = [];
    Object.entries(glossary || {})
      .sort((a, b) => b[0].length - a[0].length)
      .forEach(([ko, en]) => {
        if (purpose.includes(ko) && !used.some((u) => ko.includes(u) || u.includes(ko))) {
          used.push(ko);
          found.push([purpose.indexOf(ko), en.split('|').map((w) => w.toLowerCase())]);
        }
      });
    const re = /[A-Za-z][A-Za-z0-9\-.]+/g;
    let m;
    while ((m = re.exec(purpose)) !== null) {
      const w = m[0].toLowerCase();
      if (!STOPWORDS.has(w) && !found.some(([, g]) => g.includes(w))) found.push([m.index, [w]]);
    }
    const groups = found
      .sort((a, b) => a[0] - b[0])
      .map(([, g]) => g)
      .filter((g) => !g.every((w) => GENERIC.has(w)));
    return finishGroups(groups);
  }

  // ---------------------------------------------------------------- scoring
  function tokens(text) {
    return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  }

  function wordIn(word, toks) {
    const parts = String(word).toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!parts.length) return false;
    const has = (p) => toks.has(p) || toks.has(p + 's') || (p.endsWith('s') && toks.has(p.slice(0, -1)));
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

  /** Rarer term groups in the pool discriminate more ('korea' over 'compliance'). */
  function idfWeights(repos, groups) {
    const n = repos.length;
    if (n < 10) return groups.map(() => 1.0);
    const df = groups.map(() => 0);
    repos.forEach((r) => {
      groupScores(r, groups).scores.forEach((s, i) => {
        if (s > 0) df[i] += 1;
      });
    });
    return df.map((d) => Math.log(1 + n / (d + 1)));
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
    let rel = num / den;
    if (scores.every((s) => s > 0)) rel = Math.min(1.0, rel + 0.1);
    const why = [];
    groups.forEach((g, i) => {
      if (wheres[i]) why.push(g[0] + '<-' + wheres[i]);
    });
    return { rel, why };
  }

  function daysSince(iso, now) {
    if (!iso) return 9999;
    const ms = now.getTime() - Date.parse(iso);
    return Math.max(0, Math.floor(ms / 86400000));
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
      empty: main.length === 0,
    };
  }

  /** Every result row carries one of these. No license and unknown license are warnings. */
  function licenseBadge(spdx) {
    const s = (spdx || '').toUpperCase();
    if (!s) return { text: '라이선스 없음', tone: 'warn', note: '명시된 사용 권한 없음' };
    if (s === 'NOASSERTION' || s === 'OTHER') return { text: '라이선스 불명', tone: 'warn', note: '명시된 사용 권한 없음' };
    if (PERMISSIVE.has(s)) return { text: spdx, tone: 'ok', note: '' };
    return { text: spdx, tone: 'info', note: '사용 조건을 확인하세요' };
  }

  const FIELD_LABEL = { name: '이름', topics: '토픽', description: '설명' };

  /** "korea<-name" -> "이름에서 korea" */
  function whyLabel(item) {
    const [word, field] = item.split('<-');
    return (FIELD_LABEL[field] || field) + '에서 ' + word;
  }

  return {
    QueryError, STOPWORDS, GENERIC, PERMISSIVE, MIN_REL, MAX_QUERY_LENGTH,
    parseGlossary, parseTermsArg, parsePurpose,
    tokens, wordIn, groupScores, idfWeights, relevance, daysSince, activity, licenseStatus, scoreRepo,
    rank, select, runSearch, isPermissive, licenseBadge, whyLabel,
  };
});
