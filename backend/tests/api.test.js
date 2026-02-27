import { describe, test, expect } from 'vitest';
const request = require('supertest');
const express = require('express');

const app = express();
app.use(express.json());

app.get('/api/extract', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  res.json({ title: "Mocked", url });
});

describe('API Endpoints (Minimal)', () => {
  test('GET /api/extract requires URL', async () => {
    const res = await request(app).get('/api/extract');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('URL is required');
  });

  test('GET /api/extract returns 200 with URL', async () => {
    const res = await request(app).get('/api/extract?url=https://example.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBe('https://example.com');
  });
});
