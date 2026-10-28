/**
 * Exercise the actual MAIN-world hook, not a second copy of its parser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/page-hook.js', import.meta.url), 'utf8');
const user = (id, handle) => ({ __typename: 'User', rest_id: String(id), core: { screen_name: handle, name: handle } });
const item = (id, handle) => ({
  entryId: `user-${id}`,
  content: { itemContent: { user_results: { result: user(id, handle) } } },
});
const cursor = (value) => ({
  entryId: 'cursor-bottom',
  content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value },
});
const payload = (entries, extra = []) => ({
  data: { user: { result: {
    ...user(42, 'testuser'),
    legacy: { followers_count: 2 },
    timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }, ...extra] } },
  } } },
});

async function observe(body, { variables = { userId: '42' }, operation = 'Followers', post = false, input } = {}) {
  const messages = [];
  const window = {
    fetch: async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      clone: () => ({ json: async () => body }),
    }),
    postMessage: (message) => messages.push(structuredClone(message)),
  };
  vm.runInNewContext(source, { window, location: { origin: 'https://x.com' }, URL });
  const url = `https://x.com/i/api/graphql/query/${operation}`;
  await window.fetch(input || (post ? url : `${url}?variables=${encodeURIComponent(JSON.stringify(variables))}`),
    post ? { body: JSON.stringify({ variables }) } : undefined);
  await new Promise((resolve) => setImmediate(resolve));
  return { messages, page: messages.find((message) => message.kind === 'followers-page') };
}

test('the hook reads plain and module entries, deduplicates, and preserves request cursors', async () => {
  const module = { entryId: 'module-followers', content: { items: [
    { item: { itemContent: { user_results: { result: user(2, 'two') } } } },
  ] } };
  const { page, messages } = await observe(payload([item(1, 'one'), module, item(1, 'one'), cursor('next')]),
    { variables: { userId: '42', cursor: 'previous' } });
  assert.deepEqual(page.people.map((entry) => entry.handle), ['one', 'two']);
  assert.equal(page.requestCursor, 'previous');
  assert.equal(page.bottomCursor, 'next');
  assert.equal(page.ownerId, '42');
  assert.equal(page.expected, 2);
  assert.equal(page.valid, true);
  assert.equal(page.reachedEnd, false);
  const owner = messages.find((message) => message.kind === 'graphql');
  assert.equal(owner.payload.data.user.result.timeline, undefined, 'the full payload is not bridged');
});

test('legacy owners and visibility-wrapped users are supported', async () => {
  const body = payload([item(1, 'one')]);
  const owner = body.data.user.result;
  delete owner.core;
  owner.legacy.screen_name = 'testuser';
  body.data.user.result = { __typename: 'UserWithVisibilityResults', user: owner };
  const { page } = await observe(body);
  assert.equal(page.owner, 'testuser');
  assert.equal(page.people[0].id, '1');
  assert.equal(page.reachedEnd, true);
});

test('an empty cursor page or an explicit bottom terminator can end a list', async () => {
  assert.equal((await observe(payload([cursor('end')]))).page.reachedEnd, true);
  assert.equal((await observe(payload([item(1, 'one'), cursor('next')], [
    { type: 'TimelineTerminateTimeline', direction: 'Bottom' },
  ]))).page.reachedEnd, true);
  assert.equal((await observe(payload([]))).page.reachedEnd, true, 'zero followers has a real empty timeline');
});

test('missing instructions or GraphQL errors are never a successful empty page', async () => {
  const missing = { data: { user: { result: user(42, 'testuser') } } };
  const { page } = await observe(missing);
  assert.equal(page.valid, false);
  assert.equal(page.reachedEnd, false);
  const partial = payload([cursor('end')]);
  partial.errors = [{ message: 'Rate limited' }];
  assert.equal((await observe(partial)).page.reachedEnd, false);
});

test('unsupported instructions and unavailable accounts cannot authorize a snapshot', async () => {
  const unknown = payload([]);
  unknown.data.user.result.timeline.timeline.instructions = [{ type: 'NewUnknownShape' }];
  assert.equal((await observe(unknown)).page.reachedEnd, false);
  const unavailable = item(1, 'one');
  unavailable.content.itemContent.user_results.result = { __typename: 'UserUnavailable' };
  assert.equal((await observe(payload([unavailable, cursor('end')]))).page.valid, false);
});

test('suggested people are not mistaken for followers', async () => {
  const suggestion = { ...item(9, 'suggested'), entryId: 'who-to-follow-9' };
  const { page } = await observe(payload([item(1, 'one'), suggestion, cursor('next')]));
  assert.deepEqual(page.people.map((entry) => entry.id), ['1']);
});

test('POST variables preserve the pagination chain too', async () => {
  const { page } = await observe(payload([item(1, 'one')]), {
    post: true, variables: { userId: '42', cursor: 'post-cursor' },
  });
  assert.equal(page.requestCursor, 'post-cursor');
});

test('an already-used Request cannot break the page fetch', async () => {
  const input = {
    url: 'https://x.com/i/api/graphql/query/Followers',
    method: 'POST',
    clone() { throw new Error('Body already used'); },
  };
  const { page } = await observe(payload([item(1, 'one')]), { input });
  assert.ok(page);
});

test('unrelated POST requests are never cloned or inspected', async () => {
  let cloned = false;
  const input = {
    url: 'https://x.com/i/api/other/upload', method: 'POST',
    clone() { cloned = true; throw new Error('Not a follower request'); },
  };
  const { messages } = await observe({}, { input });
  assert.equal(cloned, false);
  assert.deepEqual(messages, []);
});

test('XHR POST variables preserve the request cursor', async () => {
  const messages = [];
  class XHR {
    open() {}
    addEventListener(_type, fn) { this.loaded = fn; }
    send() {
      this.status = 200;
      this.responseText = JSON.stringify(payload([item(1, 'one')]));
      this.loaded();
    }
  }
  const window = { XMLHttpRequest: XHR, postMessage: (message) => messages.push(structuredClone(message)) };
  vm.runInNewContext(source, { window, location: { origin: 'https://x.com' }, URL });
  const xhr = new XHR();
  xhr.open('POST', 'https://x.com/i/api/graphql/query/Followers');
  xhr.send(JSON.stringify({ variables: { userId: '42', cursor: 'xhr-cursor' } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.find((message) => message.kind === 'followers-page').requestCursor, 'xhr-cursor');
});

test('following and verified-only responses never become full follower lists', async () => {
  for (const operation of ['Following', 'BlueVerifiedFollowers']) {
    const { page, messages } = await observe(payload([item(1, 'one')]), { operation });
    assert.equal(page, undefined);
    assert.equal(messages.length, 1);
  }
});

test('a timeline-only result carries the requested owner id without inventing a count', async () => {
  const full = payload([item(1, 'one'), cursor('next')]);
  const body = { data: { user: { result: { timeline: full.data.user.result.timeline } } } };
  const { page } = await observe(body);
  assert.equal(page.owner, '');
  assert.equal(page.ownerId, '42');
  assert.equal(page.people[0].id, '1');
  assert.equal(page.expected, null);
  assert.equal(page.valid, true);
});

test('a bottom cursor that repeats the requested cursor ends a recognized timeline', async () => {
  const { page } = await observe(payload([item(1, 'one'), cursor('last')]), {
    variables: { userId: '42', cursor: 'last' },
  });
  assert.equal(page.reachedEnd, true);
});
