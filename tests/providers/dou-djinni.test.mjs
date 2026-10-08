// tests/providers/dou-djinni.test.mjs — local providers for DOU.ua and Djinni RSS feeds.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — dou + djinni (local)');

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label}: got ${a}, expected ${e}`);
}

try {
  const dou = await import(pathToFileURL(join(ROOT, 'providers/dou.mjs')).href);
  const djinni = await import(pathToFileURL(join(ROOT, 'providers/djinni.mjs')).href);

  // ── DOU ────────────────────────────────────────────────────────────
  eq(dou.default.id, 'dou', 'dou.id');
  eq(dou.default.detect({ provider: 'remoteok' }), null, 'dou.detect ignores other providers');
  eq(
    dou.buildDouFeedUrl({ category: 'Design', exp: '5plus' }),
    'https://jobs.dou.ua/vacancies/feeds/?category=Design&exp=5plus',
    'dou feed url from category + exp',
  );
  eq(
    dou.buildDouFeedUrl({ category: 'Design', exp: '10plus' }),
    'https://jobs.dou.ua/vacancies/feeds/?category=Design',
    'dou drops unknown exp value',
  );
  eq(
    dou.splitDouTitle('Senior Product Designer / UX/UI Designer в Extrawest, $2400–3500, віддалено'),
    { title: 'Senior Product Designer / UX/UI Designer', company: 'Extrawest', location: 'віддалено' },
    'dou title split drops salary fragment',
  );
  eq(
    dou.splitDouTitle('Product Designer в 6037, Варшава (Польща)'),
    { title: 'Product Designer', company: '6037', location: 'Варшава (Польща)' },
    'dou title split with city',
  );
  eq(
    dou.splitDouTitle('Level Designer в Gruy Games, від $1500, Київ, віддалено').location,
    'Київ, віддалено',
    'dou title split drops "від $1500"',
  );

  eq(
    dou.splitDouTitle('Mid/Sr. AI Product Designer в Launch Labs, Inc, за кордоном, віддалено'),
    { title: 'Mid/Sr. AI Product Designer', company: 'Launch Labs, Inc', location: 'за кордоном, віддалено' },
    'dou keeps legal suffix in company name',
  );
  {
    const j = dou.parseDouFeed('<rss><item><title>Product Designer / B2B в Other Land – Product Strategy &amp;amp; Design Accelerator, віддалено</title><link>https://jobs.dou.ua/companies/x/vacancies/1/</link></item></rss>');
    eq(j[0]?.company, 'Other Land – Product Strategy & Design Accelerator', 'dou decodes double-encoded entities');
  }
  const douXml = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<item><title>Senior Product Designer в HOLYWATER TECH, Київ, за кордоном, віддалено</title>
<link>https://jobs.dou.ua/companies/holywater/vacancies/123/?utm_source=jobsrss</link>
<description>&lt;p&gt;We build &lt;b&gt;B2B&lt;/b&gt; tools &amp;amp; more&lt;/p&gt;</description>
<pubDate>Mon, 05 Oct 2026 11:39:23 +0300</pubDate></item>
<item><title>Bad link в X, Київ</title><link>https://evil.example/vacancies/1/</link><description/></item>
</channel></rss>`;
  const douJobs = dou.parseDouFeed(douXml);
  eq(douJobs.length, 1, 'dou parser drops off-host links');
  eq(douJobs[0].url, 'https://jobs.dou.ua/companies/holywater/vacancies/123/', 'dou url stripped of utm');
  eq(douJobs[0].company, 'HOLYWATER TECH', 'dou company');
  eq(douJobs[0].location, 'Київ, за кордоном, віддалено', 'dou location');
  if ((douJobs[0].description || '').includes('B2B')) pass('dou description decoded to text');
  else fail(`dou description: ${JSON.stringify(douJobs[0].description)}`);
  if (typeof douJobs[0].postedAt === 'number') pass('dou postedAt parsed');
  else fail('dou postedAt missing');

  // ── Djinni ─────────────────────────────────────────────────────────
  eq(djinni.default.id, 'djinni', 'djinni.id');
  eq(
    djinni.buildDjinniFeedUrl({ primary_keyword: 'Design', exp_level: '5y' }),
    'https://djinni.co/jobs/rss/?primary_keyword=Design&exp_level=5y',
    'djinni feed url',
  );
  const djXml = `<rss><channel>
<item><title>Senior UI/UX designer</title><link>https://djinni.co/jobs/840857-senior-ui-ux-designer/</link>
<description>&lt;p&gt;Design SaaS dashboards&lt;/p&gt;</description><pubDate>Tue, 29 Sep 2026 14:09:30 +0300</pubDate>
<category>Design</category><category/></item>
<item><title>Not a job</title><link>https://djinni.co/developers/</link></item>
</channel></rss>`;
  const djJobs = djinni.parseDjinniFeed(djXml);
  eq(djJobs.length, 1, 'djinni parser keeps only /jobs/<id> links');
  eq(djJobs[0].company, '', 'djinni list-level company is empty');

  const detailHtml = `<html><script type="application/ld+json">
{"@context":"https://schema.org/","@type":"JobPosting","applicantLocationRequirements":{"@type":"AdministrativeArea","address":{"@type":"PostalAddress","addressCountry":null,"addressLocality":null,"addressRegion":"Europe"}},"hiringOrganization":{"@type":"Organization","name":"U1CORE"},"jobLocationType":"TELECOMMUTE","title":"Senior UI/UX designer"}
</script></html>`;
  eq(djinni.parseDjinniDetail(detailHtml), { company: 'U1CORE', location: 'Europe, Remote' }, 'djinni JSON-LD detail');

  // fetchDetails is opt-in and skipped while probing
  let calls = 0;
  const ctx = {
    fetchText: async (url) => {
      calls += 1;
      return url.includes('/rss/') ? djXml : detailHtml;
    },
    sleep: async () => {},
  };
  await djinni.default.fetch({ provider: 'djinni', primary_keyword: 'Design' }, ctx);
  eq(calls, 1, 'djinni: no detail fetch without fetchDetails');
  calls = 0;
  const enriched = await djinni.default.fetch({ provider: 'djinni', primary_keyword: 'Design', fetchDetails: true }, ctx);
  eq([calls, enriched[0].company], [2, 'U1CORE'], 'djinni: fetchDetails enriches company');
  calls = 0;
  await djinni.default.fetch({ provider: 'djinni', fetchDetails: true }, { ...ctx, maxPages: 1 });
  eq(calls, 1, 'djinni: fetchDetails skipped while probing');
} catch (err) {
  fail(`dou/djinni provider tests crashed: ${err?.stack || err}`);
}
