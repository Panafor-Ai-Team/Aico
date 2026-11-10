// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { WebBrowsingDocumentService } from '../index';

// The real headless editor stays unmocked: the bug was its markdown conversion
// blocking the event loop for minutes on a large crawled JSON page.
const mocks = vi.hoisted(() => ({
  documentModel: {
    create: vi.fn(async () => ({ id: 'doc-1' })),
    findBySource: vi.fn(async () => undefined),
  },
}));

vi.mock('@/database/models/document', () => ({
  DocumentModel: vi.fn(() => mocks.documentModel),
}));

vi.mock('@/database/models/topicDocument', () => ({
  TopicDocumentModel: vi.fn(() => ({ associate: vi.fn() })),
}));

vi.mock('@/server/services/document', () => ({
  DocumentService: vi.fn(() => ({ updateDocument: vi.fn() })),
}));

// Same shape as a `wp-json/wp/v2/posts?per_page=100` crawl, pretty-printed as the
// naive crawler does.
const wordpressPosts = (count: number) =>
  JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      content: {
        rendered: Array.from(
          { length: 40 },
          (_, j) =>
            `<p>Paragraph ${j} of post ${i} <a href="https://example.org/${j}">link</a>.</p>\n`,
        ).join(''),
      },
      id: i,
      link: `https://example.org/post-${i}/`,
      title: { rendered: `Post ${i}` },
    })),
    null,
    2,
  );

describe('WebBrowsingDocumentService with a large crawled JSON page', () => {
  it('saves it without blocking for long', async () => {
    const service = new WebBrowsingDocumentService({} as never, 'user-1');
    const content = wordpressPosts(70);
    expect(content.length).toBeGreaterThan(200_000);

    const startedAt = performance.now();
    await service.upsertCrawledDocument({
      content,
      title: 'Posts',
      url: 'https://example.org/wp-json/wp/v2/posts',
    });

    expect(performance.now() - startedAt).toBeLessThan(5000);
    expect(mocks.documentModel.create).toHaveBeenCalledOnce();
  }, 20_000);
});
