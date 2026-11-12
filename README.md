# Minimi chat agent

A chat agent that remembers conversations saved in this app and searches the web when an answer may have changed. It uses Gemini for responses, Tavily for web search and page reading, and SQLite for chat history.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

Add your `GEMINI_API_KEY` and `TAVILY_API_KEY` to `.env`, then run:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Nodemon restarts the server when code changes. Run `npm test` for the local checks.

## What it can do

- Find earlier messages across chats by date or topic, including questions like “What did I ask last Tuesday?”
- Search current sources and read relevant webpages before answering questions about changing facts.
- Compare a saved discussion with current evidence, and say when a claimed change cannot be verified.
- Stream answers into the browser as they are generated.

Chat history lives in `./data` by default. `APP_TIME_ZONE` controls how dates and times are interpreted. The agent can recall chats stored in this app, but cannot access conversations from other services.

See [DESIGN.md](DESIGN.md) for the architecture, workflows, and tradeoffs.
