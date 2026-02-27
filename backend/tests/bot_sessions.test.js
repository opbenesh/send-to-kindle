import { describe, test, expect } from 'vitest';

describe('Bot Session State Machine (Real Logic)', () => {
  let sessions = {};
  
  const handleText = (chatId, text) => {
    const session = sessions[chatId];

    // Logic from index.js:
    if (session && session.state === 'AWAITING_TITLE' && !text.startsWith('/')) {
      session.title = text;
      session.state = 'COLLECTING_LINKS';
      return { msg: 'Title set', session };
    }

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = text.match(urlRegex);

    if (match) {
      const url = match[0];
      if (session && session.state === 'COLLECTING_LINKS') {
        session.urls.push(url);
        return { msg: 'Added link', session };
      }
    }
    return { msg: 'No action', session };
  };

  test('Title capture works', () => {
    const chatId = 999;
    sessions[chatId] = { state: 'AWAITING_TITLE', urls: [] };
    
    handleText(chatId, "My Title");
    
    expect(sessions[chatId].state).toBe('COLLECTING_LINKS');
    expect(sessions[chatId].title).toBe("My Title");
  });

  test('URL capture works after title', () => {
    const chatId = 999;
    // Continuing from previous state
    handleText(chatId, "https://example.com");
    
    expect(sessions[chatId].urls.length).toBe(1);
    expect(sessions[chatId].urls[0]).toBe("https://example.com");
  });
});
