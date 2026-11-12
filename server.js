import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './lib/config.js';
import { Store } from './lib/store.js';
import { answer } from './lib/agent.js';

loadEnv();

const store = new Store();
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const conversationsInProgress = new Set();
const port = Number(process.env.PORT || 3000);

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let text = '';

  for await (const chunk of request) {
    text += chunk;
    if (text.length > 20_000) throw new Error('Request too large');
  }

  return JSON.parse(text || '{}');
}

function sendEvent(response, eventName, data) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChat(request, response, conversationId) {
  const { message } = await readJson(request);

  if (typeof message !== 'string' || !message.trim() || message.length > 10_000) {
    sendJson(response, 400, { error: 'Message must be 1–10,000 characters' });
    return;
  }

  if (conversationsInProgress.has(conversationId)) {
    sendJson(response, 409, { error: 'This conversation is already responding' });
    return;
  }

  const userMessage = message.trim();
  conversationsInProgress.add(conversationId);
  store.add(conversationId, 'user', userMessage);

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  try {
    sendEvent(response, 'status', { text: 'Thinking…' });

    const result = await answer(
      store,
      conversationId,
      userMessage,
      text => sendEvent(response, 'status', { text }),
      text => sendEvent(response, 'delta', { text }),
      () => sendEvent(response, 'reset', {})
    );

    store.add(conversationId, 'assistant', result.text, result.sources);
    console.info('Gemini usage', JSON.stringify(result.usage));
    sendEvent(response, 'answer', result);
  } catch (error) {
    sendEvent(response, 'error', { error: error.message });
  } finally {
    conversationsInProgress.delete(conversationId);
    response.end();
  }
}

async function serveFile(response, filename) {
  const contentTypes = {
    'index.html': 'text/html',
    'app.js': 'text/javascript',
    'markdown.js': 'text/javascript',
    'style.css': 'text/css'
  };

  const content = await fs.readFile(path.join(publicDirectory, filename));
  response.writeHead(200, { 'Content-Type': contentTypes[filename] });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/api/conversations') {
      let cursor = null;
      if (url.searchParams.has('cursor')) {
        try {
          cursor = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString());
        } catch {
          throw new Error('Invalid conversation cursor');
        }
        if (typeof cursor?.created_at !== 'string' || typeof cursor?.id !== 'string') {
          throw new Error('Invalid conversation cursor');
        }
      }

      const rows = store.listConversations(cursor, 51);
      const conversations = rows.slice(0, 50);
      const last = conversations.at(-1);
      const nextCursor = rows.length > 50
        ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url')
        : null;
      sendJson(response, 200, { conversations, nextCursor });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/conversations') {
      sendJson(response, 201, { id: store.createConversation() });
      return;
    }

    const match = url.pathname.match(/^\/api\/conversations\/([a-f0-9-]+)(\/messages)?$/);

    if (match) {
      const conversationId = match[1];

      if (!store.hasConversation(conversationId)) {
        sendJson(response, 404, { error: 'Conversation not found' });
      } else if (request.method === 'GET' && match[2]) {
        sendJson(response, 200, store.messages(conversationId));
      } else if (request.method === 'POST' && match[2]) {
        await handleChat(request, response, conversationId);
      } else {
        sendJson(response, 404, { error: 'Not found' });
      }

      return;
    }

    const publicFiles = {
      '/': 'index.html',
      '/app.js': 'app.js',
      '/markdown.js': 'markdown.js',
      '/style.css': 'style.css'
    };

    if (request.method === 'GET' && publicFiles[url.pathname]) {
      await serveFile(response, publicFiles[url.pathname]);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    if (response.headersSent) response.end();
    else sendJson(response, 400, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`minimi agent listening on http://localhost:${port}`);
});
