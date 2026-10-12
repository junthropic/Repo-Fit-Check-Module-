// Runs the site's query handling and ranking on JSON read from stdin and prints the result as JSON.
// Used by tests/test_parity.py to compare with repo-fit-check's discover.py (AC-6).
//   {repos, cases:[{purpose|terms, allowed?, avoid?}], now, glossary}   -> one result per case
//   {constants: true}                                                    -> the shared constants
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'search.js'));

const input = JSON.parse(fs.readFileSync(0, 'utf8'));

if (input.round3) {
  process.stdout.write(JSON.stringify(input.round3.map((x) => S.round3(x))));
  process.exit(0);
}

if (input.constants) {
  process.stdout.write(JSON.stringify({
    stopwords: [...S.STOPWORDS].sort(), generic: [...S.GENERIC].sort(), grammar: [...S.GRAMMAR].sort(), weak: [...S.WEAK].sort(), singleLetterOk: [...S.SINGLE_LETTER_OK].sort(),
    minRel: S.MIN_REL, maxGroups: S.MAX_GROUPS, permissive: [...S.PERMISSIVE].sort(),
  }));
  process.exit(0);
}

const now = new Date(input.now);
const glossary = S.parseGlossary(input.glossary);
const pick = (r) => ({
  full_name: r.full_name, rel: r.rel, pop: r.pop, days: r.days, lic_status: r.lic_status, score: r.score, why: r.why,
});

const results = input.cases.map((c) => {
  let interpretation;
  try {
    interpretation = c.purpose !== undefined ? S.interpretPurpose(c.purpose, glossary) : S.interpretTerms(c.terms);
  } catch (e) {
    if (e instanceof S.QueryError) return { error: e.code };
    throw e;
  }
  const { groups, dropped, ignored, omitted } = interpretation;
  const { scored, excluded } = S.rank(input.repos, groups, {
    allowed: c.allowed || [], avoid: c.avoid || [], minRel: S.MIN_REL, now,
  });
  const { main, small } = S.select(scored, { top: 10 });
  return {
    groups, dropped, ignored, omitted, main: main.map(pick), small: small.map(pick),
    scored: scored.length, excluded: excluded.length, unmatched: S.unmatchedGroups(input.repos, groups),
  };
});
process.stdout.write(JSON.stringify(results));
