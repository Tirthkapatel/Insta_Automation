import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotionRow } from '../../ig-autodm/notion-config.mjs';

test('parseNotionRow extracts all DM columns', () => {
  const fakeRow = {
    id: 'page_abc',
    properties: {
      ig_media_id: { type: 'rich_text', rich_text: [{ plain_text: '1234567' }] },
      dm_trigger_keyword: { type: 'rich_text', rich_text: [{ plain_text: 'link' }] },
      dm_message_text: { type: 'rich_text', rich_text: [{ plain_text: 'Here you go!' }] },
      dm_link_url: { type: 'url', url: 'https://example.com' },
      dm_link_title: { type: 'rich_text', rich_text: [{ plain_text: 'Open' }] },
      comment_reply_text: { type: 'rich_text', rich_text: [] },
      dm_status: { type: 'select', select: { name: 'active' } },
    },
  };
  const parsed = parseNotionRow(fakeRow);
  assert.equal(parsed.ig_media_id, '1234567');
  assert.equal(parsed.dm_trigger_keyword, 'link');
  assert.equal(parsed.dm_message_text, 'Here you go!');
  assert.equal(parsed.dm_link_url, 'https://example.com');
  assert.equal(parsed.dm_link_title, 'Open');
  assert.equal(parsed.comment_reply_text, '');
  assert.equal(parsed.dm_status, 'active');
});

test('parseNotionRow handles missing dm_status as inactive', () => {
  const fakeRow = {
    id: 'page_abc',
    properties: {
      ig_media_id: { type: 'rich_text', rich_text: [{ plain_text: '999' }] },
      dm_trigger_keyword: { type: 'rich_text', rich_text: [] },
      dm_message_text: { type: 'rich_text', rich_text: [] },
      dm_link_url: { type: 'url', url: null },
      dm_link_title: { type: 'rich_text', rich_text: [] },
      comment_reply_text: { type: 'rich_text', rich_text: [] },
      dm_status: { type: 'select', select: null },
    },
  };
  const parsed = parseNotionRow(fakeRow);
  assert.equal(parsed.dm_status, 'inactive');
});

test('parseNotionRow defaults missing trigger keyword to *', () => {
  const fakeRow = {
    id: 'page_abc',
    properties: {
      ig_media_id: { type: 'rich_text', rich_text: [{ plain_text: '999' }] },
      dm_trigger_keyword: { type: 'rich_text', rich_text: [] },
      dm_message_text: { type: 'rich_text', rich_text: [] },
      dm_link_url: { type: 'url', url: null },
      dm_link_title: { type: 'rich_text', rich_text: [] },
      comment_reply_text: { type: 'rich_text', rich_text: [] },
      dm_status: { type: 'select', select: { name: 'active' } },
    },
  };
  const parsed = parseNotionRow(fakeRow);
  assert.equal(parsed.dm_trigger_keyword, '*');
});
