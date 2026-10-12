// Runs the site's ranking on JSON read from stdin and prints the result as JSON.
// Used by tests/test_parity.py to compare with repo-fit-check's discover.py (AC-6).
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'search.js'));

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const now = new Date(input.now);
const glossary = S.parseGlossary(input.glossary);
const pick = (r) => ({
  full_name: r.full_name, rel: r.rel, pop: r.pop, days: r.days, lic_status: r.lic_status, score: r.score, why: r.why,
});

const results = input.cases.map((c) => {
  let groups;
  try {
    groups = c.purpose !== undefined ? S.parsePurpose(c.purpose, glossary) : S.parseTermsArg(c.terms);
  } catch (e) {
    if (e instanceof S.QueryError) return { error: e.code };
    throw e;
  }
  const { scored, excluded } = S.rank(input.repos, groups, {
    allowed: c.allowed || [], avoid: c.avoid || [], minRel: 0.34, now,
  });
  const { main, small } = S.select(scored, { top: 10 });
  return { groups, main: main.map(pick), small: small.map(pick), scored: scored.length, excluded: excluded.length };
});
process.stdout.write(JSON.stringify(results));
