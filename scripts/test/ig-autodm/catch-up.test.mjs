import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCatchUp } from '../../ig-autodm/catch-up.mjs';
import { createMemoryDedupe } from '../../ig-autodm/dedupe-store.mjs';

const SELF_ID = 'self_999';
const SELF_HANDLE = 'test.user';

const baseConfig = {
  ig_media_id: 'media_1',
  dm_trigger_keyword: '*',
  dm_message_text: 'thanks!',
  dm_link_url: 'https://example.com',
  dm_link_title: 'Open',
  comment_reply_text: 'check DMs',
  dm_status: 'active',
};

function makeComment({ id, fromId, fromUsername, text, secondsAgo = 60 }) {
  return {
    id,
    text,
    timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    from: { id: fromId, username: fromUsername },
  };
}

function makeApiSpies() {
  const sent = { comment_reply: [], private_reply: [] };
  return {
    sent,
    sendCommentReply: async (commentId, message) => { sent.comment_reply.push({ commentId, message }); },
    sendPrivateReply: async ({ commentId, message }) => { sent.private_reply.push({ commentId, message }); },
    sleep: async () => {}, // no-op for fast tests
  };
}

test('catch-up sends DM + reply for unmissed comment', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: 'u1', fromUsername: 'alice', text: 'DM' }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 1);
  assert.equal(api.sent.comment_reply.length, 1);
  assert.equal(result.stats.sent_dm, 1);
  assert.equal(result.stats.sent_reply, 1);
});

test('catch-up skips comments already in dedupe', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  await dedupe.set('sent:media_1:u1', 60);

  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: 'u1', fromUsername: 'alice', text: 'DM' }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 0);
  assert.equal(result.stats.skipped_deduped, 1);
});

test('catch-up skips self comments', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: SELF_ID, fromUsername: SELF_HANDLE, text: 'my own reply' }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 0);
  assert.equal(result.stats.skipped_no_match, 1);
});

test('catch-up skips comments older than 7 days', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: 'u1', fromUsername: 'alice', text: 'DM', secondsAgo: 8 * 86400 }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 0);
});

test('catch-up sends to multiple users on same media independently', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: 'u1', fromUsername: 'alice', text: 'DM' }),
    makeComment({ id: 'c2', fromId: 'u2', fromUsername: 'bob', text: 'DM' }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 2);
  assert.equal(result.stats.sent_dm, 2);
});

test('catch-up dedupes same user across multiple comments on same media', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: 'u1', fromUsername: 'alice', text: 'DM' }),
    makeComment({ id: 'c2', fromId: 'u1', fromUsername: 'alice', text: 'DM again' }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 1);
  assert.equal(result.stats.sent_dm, 1);
  assert.equal(result.stats.skipped_deduped, 1);
});

test('catch-up respects MAX_SENDS_PER_RUN safety cap', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push(makeComment({ id: `c${i}`, fromId: `u${i}`, fromUsername: `user${i}`, text: 'DM' }));
  }
  // config has comment_reply_text set, so each match = 2 sends
  const fetchComments = async () => many;

  const result = await runCatchUp({
    configByMediaId: { media_1: baseConfig },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  const totalSends = api.sent.comment_reply.length + api.sent.private_reply.length;
  assert.ok(totalSends <= 25, `expected ≤25 sends, got ${totalSends}`);
  assert.equal(result.stats.capped, true);
});

test('catch-up keyword match filters non-matching comments', async () => {
  const api = makeApiSpies();
  const dedupe = createMemoryDedupe();
  const cfg = { ...baseConfig, dm_trigger_keyword: 'link' };
  const fetchComments = async () => [
    makeComment({ id: 'c1', fromId: 'u1', fromUsername: 'alice', text: 'send me the link' }),
    makeComment({ id: 'c2', fromId: 'u2', fromUsername: 'bob', text: '🔥' }),
  ];

  const result = await runCatchUp({
    configByMediaId: { media_1: cfg },
    fetchComments, dedupe,
    sendCommentReply: api.sendCommentReply,
    sendPrivateReply: api.sendPrivateReply,
    sleep: api.sleep,
    selfIgUserId: SELF_ID, selfIgUsername: SELF_HANDLE,
  });

  assert.equal(api.sent.private_reply.length, 1);
  assert.equal(api.sent.private_reply[0].commentId, 'c1');
  assert.equal(result.stats.skipped_no_match, 1);
});
