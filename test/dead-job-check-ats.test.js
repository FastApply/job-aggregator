// The pruner's per-ATS liveness reads: Workday CXS, SmartRecruiters Posting API.
// fetch is stubbed; no network.
const test = require('node:test');
const assert = require('node:assert');
const {
  checkUrl, readWorkdayError, smartRecruitersPostingApi,
} = require('../src/tasks/dead-job-check');

const WD = 'https://lmcu.wd5.myworkdayjobs.com/lmcucareersite/job/Grand-Rapids-MI/BSA-Operations-Intern_REQ-2026-6996';
const SR = 'https://jobs.smartrecruiters.com/Grab/744000151028388-senior-software-engineer-backend';

function stub(routes) {
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    seen.push(String(url));
    for (const [match, answer] of routes) {
      if (String(url).includes(match)) {
        const { status = 200, json, text } = answer;
        return {
          status,
          ok: status >= 200 && status < 300,
          url: String(url),
          headers: new Map(),
          json: async () => { if (json === undefined) throw new Error('not json'); return json; },
          text: async () => text ?? JSON.stringify(json ?? ''),
        };
      }
    }
    throw new Error('unrouted ' + url);
  };
  return { seen, restore: () => { global.fetch = orig; } };
}

test('Workday: 403 S22 from the CXS resource is gone', async () => {
  const s = stub([['/wday/cxs/', { status: 403, json: { errorCode: 'S22', message: 'permission denied', httpStatus: 403 } }]]);
  try {
    const r = await checkUrl(WD);
    assert.strictEqual(r.alive, false);
    assert.match(s.seen[0], /\/wday\/cxs\/lmcu\/lmcucareersite\/job\/Grand-Rapids-MI\/BSA-Operations-Intern_REQ-2026-6996$/);
  } finally { s.restore(); }
});

test('Workday: 404 with Workday errorCode is gone', async () => {
  const s = stub([['/wday/cxs/', { status: 404, json: { errorCode: 'HTTP_404', httpStatus: 404 } }]]);
  try { assert.strictEqual((await checkUrl(WD)).alive, false); } finally { s.restore(); }
});

test('Workday: an HTML 403 (edge block) is no opinion, never gone', async () => {
  const s = stub([['/wday/cxs/', { status: 403, text: '<html>Access denied</html>' }]]);
  try { assert.strictEqual((await checkUrl(WD)).alive, null); } finally { s.restore(); }
});

test('Workday: a 403 JSON without S22, or a body disagreeing with its status, is no opinion', async () => {
  assert.strictEqual(readWorkdayError(403, { errorCode: 'X1' }), false);
  assert.strictEqual(readWorkdayError(404, { errorCode: 'HTTP_404', httpStatus: 403 }), false);
  assert.strictEqual(readWorkdayError(404, { message: 'nope' }), false);
  assert.strictEqual(readWorkdayError(403, { errorCode: 'S22' }), true);
});

test('Workday: 200 with jobPostingInfo is alive', async () => {
  const s = stub([['/wday/cxs/', { status: 200, json: { jobPostingInfo: { title: 'BSA Operations Intern' } } }]]);
  try { assert.strictEqual((await checkUrl(WD)).alive, true); } finally { s.restore(); }
});

test('SmartRecruiters: active:false from the Posting API is gone, without reading the page', async () => {
  const s = stub([['api.smartrecruiters.com', { status: 200, json: { id: '744000151028388', active: false } }]]);
  try {
    assert.strictEqual((await checkUrl(SR)).alive, false);
    assert.deepStrictEqual(s.seen, ['https://api.smartrecruiters.com/v1/companies/Grab/postings/744000151028388']);
  } finally { s.restore(); }
});

test('SmartRecruiters: active:true is alive', async () => {
  const s = stub([['api.smartrecruiters.com', { status: 200, json: { id: '744000151028388', active: true } }]]);
  try { assert.strictEqual((await checkUrl(SR)).alive, true); } finally { s.restore(); }
});

test('SmartRecruiters: an API 404 is no opinion, so the page check still decides', async () => {
  const s = stub([
    ['api.smartrecruiters.com', { status: 404, json: { message: 'not found' } }],
    ['jobs.smartrecruiters.com', { status: 403, text: 'datadome' }],
  ]);
  try {
    const r = await checkUrl(SR);
    assert.strictEqual(r.alive, null);
    assert.strictEqual(s.seen.length, 2);
  } finally { s.restore(); }
});

test('SmartRecruiters: only posting URLs on SmartRecruiters hosts are asked', () => {
  assert.strictEqual(smartRecruitersPostingApi('https://smartrecruiters.com/BESIX/744000126498469'),
    'https://api.smartrecruiters.com/v1/companies/BESIX/postings/744000126498469');
  assert.strictEqual(smartRecruitersPostingApi('https://jobs.smartrecruiters.com/Grab'), null);
  assert.strictEqual(smartRecruitersPostingApi('https://jobs.smartrecruiters.com.evil.net/Grab/744000151028388'), null);
  assert.strictEqual(smartRecruitersPostingApi('https://example.com/Grab/744000151028388'), null);
});

const OC = 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210764737';

test('Oracle: an empty items array from the requisition API is gone', async () => {
  const s = stub([['recruitingCEJobRequisitionDetails', { status: 200, json: { items: [] } }]]);
  try {
    assert.strictEqual((await checkUrl(OC)).alive, false);
    assert.match(s.seen[0], /^https:\/\/jpmc\.fa\.oraclecloud\.com\/hcmRestApi\/.*finder=ById;Id=210764737,siteNumber=CX_1001$/);
  } finally { s.restore(); }
});

test('Oracle: one item is alive, a body without items is no opinion', async () => {
  let s = stub([['recruitingCEJobRequisitionDetails', { status: 200, json: { items: [{ Id: '210764737' }] } }]]);
  try { assert.strictEqual((await checkUrl(OC)).alive, true); } finally { s.restore(); }
  s = stub([['recruitingCEJobRequisitionDetails', { status: 200, json: { message: 'x' } }]]);
  try { assert.strictEqual((await checkUrl(OC)).alive, null); } finally { s.restore(); }
});
