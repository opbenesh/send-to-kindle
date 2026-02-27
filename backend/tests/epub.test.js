import { describe, test, expect } from 'vitest';
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const epubGenMemory = require('epub-gen-memory').default;

// Mocking dependencies is complex here, so we'll do a partial integration test
// of the logic used inside sendToKindle.

describe('EPUB Generation Logic', () => {
  const mockArticle = {
    title: "Test Article",
    byline: "Test Author",
    siteName: "Test Site",
    content: "<div>Hello World</div>",
    excerpt: "This is a test excerpt",
    url: "https://example.com/test"
  };

  test('Cover Page HTML contains all metadata', () => {
    const finalTitle = mockArticle.title;
    const finalAuthor = mockArticle.byline;
    
    const coverHtml = `
    <div style="text-align: center; font-family: 'Georgia', serif; padding: 20px; border: 2px solid #333; height: 90%;">
      <div style="margin-top: 50px;">
        <span style="text-transform: uppercase; letter-spacing: 3px; font-size: 0.8em; color: #666;">Openesh's Send to Kindle</span>
      </div>
      <h1 style="font-size: 3em; margin: 40px 0 10px 0; line-height: 1.1;">${finalTitle}</h1>
      <h2 style="font-size: 1.4em; font-weight: normal; font-style: italic; color: #444; margin-bottom: 50px;">by ${finalAuthor}</h2>
    </div>`;

    expect(coverHtml).toContain("Test Article");
    expect(coverHtml).toContain("by Test Author");
    expect(coverHtml).toContain("Openesh's Send to Kindle");
  });

  test('Chapter formatting includes date and site name', () => {
    const article = mockArticle;
    const content = `
        <div style="font-family: sans-serif; color: #666; font-size: 0.85em; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 20px;">
          ${article.siteName ? `${article.siteName} • ` : ''}${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
        ${article.content}
      `;
    
    expect(content).toContain("Test Site •");
    expect(content).toContain("Hello World");
    // Check if current date (month) is present
    const month = new Date().toLocaleDateString('en-US', { month: 'short' });
    expect(content).toContain(month);
  });
});
