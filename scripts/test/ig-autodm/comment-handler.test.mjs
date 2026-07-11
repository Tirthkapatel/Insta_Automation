import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planActions } from '../../ig-autodm/comment-handler.mjs';

const baseConfig = {
  ig_media_id: '17900000000000001',
  dm_trigger_keyword: '*',
  dm_message_text: 'Here you go!',
  dm_link_url: 'https://example.com',
  dm_link_title: 'Open guide',
  comment_reply_text: '',
  dm_status: 'active',
};

const baseComment = {
  id: 'comment_123',
  media_id: '17900000000000001',
  from_id: 'user_456',
  from_username: 'tester',
  text: 'love this!',
  created_at_unix: Math.floor(Date.now() / 1000),
};

const SELF_IG_USER_ID = 'self_999';

test('star keyword fires DM on any comment', () => {
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'send_private_reply');
  assert.equal(actions[0].to_comment_id, 'comment_123');
});

test('specific keyword matches case-insensitive substring', () => {
  const cfg = { ...baseConfig, dm_trigger_keyword: 'link' };
  const c = { ...baseComment, text: 'send LINK pls' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 1);
});

test('specific keyword does not match unrelated comment', () => {
  const cfg = { ...baseConfig, dm_trigger_keyword: 'link' };
  const c = { ...baseComment, text: 'nice video' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips comments from self by id', () => {
  const c = { ...baseComment, from_id: SELF_IG_USER_ID };
  const actions = planActions({
    comment: c,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips comments from self by username (when Meta omits from.id)', () => {
  const c = { ...baseComment, from_id: undefined, from_username: 'test.user' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
    selfIgUsername: 'test.user',
  });
  assert.equal(actions.length, 0);
});

test('skips comments with no identifiable sender (defensive)', () => {
  const c = { ...baseComment, from_id: undefined, from_username: undefined };
  const actions = planActions({
    comment: c,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips comment whose text equals our own reply text (loop guard)', () => {
  const cfg = { ...baseConfig, comment_reply_text: 'Check your DMs 📩' };
  const c = { ...baseComment, from_id: 'someone_else', text: 'Check your DMs 📩' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips comments older than 7 days (Private Replies window)', () => {
  const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
  const c = { ...baseComment, created_at_unix: eightDaysAgo };
  const actions = planActions({
    comment: c,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips when no config exists for media_id', () => {
  const actions = planActions({
    comment: baseComment,
    configByMediaId: {},
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips when dm_status is not active', () => {
  const cfg = { ...baseConfig, dm_status: 'inactive' };
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('also queues public comment reply when reply text is set', () => {
  const cfg = { ...baseConfig, comment_reply_text: 'Check your DMs 📩' };
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, 'send_comment_reply');
  assert.equal(actions[1].type, 'send_private_reply');
});

test('reply variations: multi-line text picks one randomly per call', () => {
  const cfg = {
    ...baseConfig,
    comment_reply_text: 'DMed you 💬\nCheck your DMs!\nSliding in 📩\nSent 👇',
  };
  // Force the random to pick index 2 (third line).
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
    random: () => 2 / 4,
  });
  assert.equal(actions[0].type, 'send_comment_reply');
  assert.equal(actions[0].text, 'Sliding in 📩');
});

test('reply variations: each variation appears across many random picks', () => {
  const variations = ['A', 'B', 'C', 'D'];
  const cfg = { ...baseConfig, comment_reply_text: variations.join('\n') };
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const actions = planActions({
      comment: baseComment,
      configByMediaId: { [cfg.ig_media_id]: cfg },
      selfIgUserId: SELF_IG_USER_ID,
    });
    seen.add(actions[0].text);
  }
  // Statistically near-certain to see every variation in 200 picks of 4.
  for (const v of variations) {
    assert.ok(seen.has(v), `expected to see ${v} in random picks (saw: ${[...seen].join(',')})`);
  }
});

test('DM message variations: multi-line picks one randomly', () => {
  const cfg = {
    ...baseConfig,
    dm_message_text: 'Here you go!\nThanks for asking, here is the link\nLink below 👇',
  };
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
    random: () => 0.5, // mid range -> index 1 (second line)
  });
  const dmAction = actions.find(a => a.type === 'send_private_reply');
  assert.equal(dmAction.message, 'Thanks for asking, here is the link');
});

test('loop guard: comment matching ANY reply variation is skipped', () => {
  const cfg = {
    ...baseConfig,
    comment_reply_text: 'DMed you 💬\nCheck your DMs!\nSliding in 📩',
  };
  const c = { ...baseComment, text: 'Sliding in 📩' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('single-line reply text still works (no variation)', () => {
  const cfg = { ...baseConfig, comment_reply_text: 'Check your DMs 📩' };
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions[0].text, 'Check your DMs 📩');
});
