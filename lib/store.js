import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { localDate } from './config.js';
import { resolveDateReference } from './dates.js';

const commonWords = new Set([
  'what', 'when', 'where', 'which', 'about', 'since', 'then', 'today',
  'asked', 'last', 'this', 'that', 'have', 'with', 'from', 'your',
  'answer', 'still', 'correct', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'did', 'ask', 'you', 'our',
  'the', 'for', 'has', 'any', 'them',
  'were', 'was', 'and', 'can', 'are', 'now', 'big'
]);

export class Store {
  constructor(directory = process.env.DATA_DIR || './data') {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'chat.sqlite'));

    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_by_date
        ON conversations(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        local_date TEXT,
        sources TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS messages_by_conversation
        ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS first_user_message
        ON messages(created_at, id) WHERE role = 'user';
      CREATE INDEX IF NOT EXISTS first_user_message_in_chat
        ON messages(conversation_id, created_at, id) WHERE role = 'user';
      CREATE INDEX IF NOT EXISTS first_user_question
        ON messages(created_at, id) WHERE role = 'user' AND instr(content, '?') > 0;
      CREATE INDEX IF NOT EXISTS first_user_question_in_chat
        ON messages(conversation_id, created_at, id)
        WHERE role = 'user' AND instr(content, '?') > 0;
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
        USING fts5(content, content='messages', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO message_fts(rowid, content) VALUES(new.id, new.content);
      END;
    `);

    this.migrateOldMessages();
  }

  migrateOldMessages() {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all();
    const hasLocalDate = columns.some(column => column.name === 'local_date');

    if (!hasLocalDate) this.db.exec('ALTER TABLE messages ADD COLUMN local_date TEXT');

    this.db.exec('CREATE INDEX IF NOT EXISTS messages_by_local_date ON messages(local_date, id)');
    this.db.exec(`CREATE INDEX IF NOT EXISTS user_messages_by_local_date
      ON messages(local_date, id) WHERE role = 'user'`);

    const oldMessages = this.db.prepare(
      'SELECT id, created_at FROM messages WHERE local_date IS NULL'
    ).all();

    if (oldMessages.length === 0) return;

    const update = this.db.prepare('UPDATE messages SET local_date = ? WHERE id = ?');
    this.db.exec('BEGIN');

    try {
      for (const message of oldMessages) {
        update.run(localDate(new Date(message.created_at)), message.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createConversation() {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO conversations VALUES (?, ?)')
      .run(id, new Date().toISOString());
    return id;
  }

  hasConversation(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id));
  }

  listConversations(cursor = null, limit = 100) {
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const where = cursor ? 'WHERE (c.created_at, c.id) < (?, ?)' : '';
    const statement = this.db.prepare(`
      SELECT c.id, c.created_at,
        COALESCE((
          SELECT substr(content, 1, 90)
          FROM messages
          WHERE conversation_id = c.id AND role = 'user'
          ORDER BY id LIMIT 1
        ), 'New chat') AS title
      FROM conversations c
      ${where}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?
    `);
    return cursor
      ? statement.all(cursor.created_at, cursor.id, pageSize)
      : statement.all(pageSize);
  }

  messages(conversationId, limit = 100) {
    const rows = this.db.prepare(`
      SELECT id, role, content, created_at, local_date, sources
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(conversationId, limit);

    return rows.reverse().map(row => ({
      ...row,
      sources: JSON.parse(row.sources)
    }));
  }

  add(conversationId, role, content, sources = [], at = new Date()) {
    this.db.prepare(`
      INSERT INTO messages(conversation_id, role, content, created_at, local_date, sources)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversationId, role, content, at.toISOString(), localDate(at), JSON.stringify(sources));
  }

  firstUserMessage(conversationId = null) {
    const where = conversationId ? 'AND conversation_id = ?' : '';
    const statement = this.db.prepare(`
      SELECT id, conversation_id, content, created_at
      FROM messages
      WHERE role = 'user' ${where}
      ORDER BY created_at, id
      LIMIT 1
    `);
    return conversationId ? statement.get(conversationId) : statement.get();
  }

  firstUserQuestion(conversationId = null) {
    const where = conversationId ? 'AND conversation_id = ?' : '';
    const statement = this.db.prepare(`
      SELECT id, conversation_id, content, created_at
      FROM messages
      WHERE role = 'user' AND instr(content, '?') > 0 ${where}
      ORDER BY created_at, id
      LIMIT 1
    `);
    return conversationId ? statement.get(conversationId) : statement.get();
  }

  countMessagesOnDate(start, end) {
    return this.db.prepare(`
      SELECT count(*) AS total FROM messages
      WHERE local_date BETWEEN ? AND ? AND role = 'user'
    `).get(start, end).total;
  }

  recall(conversationId, query, recentIds = [], now = new Date()) {
    const date = resolveDateReference(query, now);
    const matches = new Map();
    const excluded = new Set(recentIds);
    const nextMessage = this.db.prepare(`
      SELECT id, role, content, created_at, local_date, sources
      FROM messages WHERE conversation_id = ? AND id > ?
      ORDER BY id LIMIT 1
    `);
    const previousMessage = this.db.prepare(`
      SELECT id, role, content, created_at, local_date, sources
      FROM messages WHERE conversation_id = ? AND id < ?
      ORDER BY id DESC LIMIT 1
    `);

    const add = message => {
      if (message && !excluded.has(message.id)) matches.set(message.id, message);
    };
    const addWithReply = message => {
      if (message.role === 'assistant') {
        const previous = previousMessage.get(message.conversation_id, message.id);
        if (previous?.role === 'user') add(previous);
      }
      add(message);
      if (message.role === 'user') {
        const next = nextMessage.get(message.conversation_id, message.id);
        if (next?.role === 'assistant') add(next);
      }
    };

    const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    const usefulWords = [...new Set(words.filter(word => !commonWords.has(word)))].slice(0, 8);
    const searchText = usefulWords.map(word => `"${word}"`).join(' OR ');

    // A dated topic search can find a relevant message even on a crowded day.
    if (date) {
      if (searchText) {
        const datedTopics = this.db.prepare(`
          SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.local_date, m.sources
          FROM message_fts f JOIN messages m ON m.id = f.rowid
          WHERE message_fts MATCH ? AND m.local_date BETWEEN ? AND ?
          ORDER BY rank LIMIT 24
        `).all(searchText, date.start, date.end);
        for (const message of datedTopics) addWithReply(message);
      }

      const dateMatches = this.db.prepare(`
        SELECT id, conversation_id, role, content, created_at, local_date, sources
        FROM messages
        WHERE local_date BETWEEN ? AND ?
        ORDER BY id LIMIT 80
      `).all(date.start, date.end);
      for (const message of dateMatches) add(message);
    }

    if (searchText) {
      const topicMatches = this.db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.local_date, m.sources
        FROM message_fts f
        JOIN messages m ON m.id = f.rowid
        WHERE message_fts MATCH ?
        ORDER BY rank
        LIMIT 8
      `).all(searchText);
      for (const message of topicMatches) addWithReply(message);
    }

    // Keep relevance order: dated topic matches, dated messages, then other topic matches.
    return [...matches.values()]
      .map(message => ({ ...message, sources: JSON.parse(message.sources) }));
  }
}
