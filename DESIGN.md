# minimi search agent

## Goal

A useful chat agent needs to remember what the user actually asked, know when a claim may have changed, search efficiently, and show the evidence behind its answer. This implementation favors a small, inspectable architecture over a large framework.

## Architecture

```text
Browser ── SSE ── Node HTTP server ── agent loop ── Gemini generateContent
                         │                 │
                         │                 └── web_search ── Tavily
                         └── SQLite conversations + FTS5 recall
```

The model has exactly one callable tool, `web_search`. It can issue multiple focused queries in one model turn; the server executes up to six in parallel. Tavily uses basic search for ordinary lookups and advanced search for pricing, cost, changes, and release notes; an empty basic search retries at advanced depth. The server returns up to four or five results respectively, keeps the first result for each URL, and caps each snippet at 900 characters. Identical searches share an in-flight request and a two-minute cache. If snippets lack exact facts, Gemini can call the same tool with up to three URLs from its search results. The server uses Tavily Extract to return a few query-relevant chunks from those pages; pricing pages use advanced extraction so tables are more likely to be included. This two-step flow avoids extracting every result. There are at most three tool rounds and a final answer round. Tool errors and per-page extraction failures go back to the model so it can state the limitation rather than silently inventing results.

The server stores each user and assistant message, UTC timestamp, local calendar date, and source URLs in SQLite. The local date is a small indexed field derived from the timestamp; existing databases are migrated on startup. Recent turns are supplied directly. Older turns across conversations are retrieved by indexed date lookup and FTS5. A deterministic parser resolves “Monday,” “last Tuesday,” “last week,” and named dates against the configured time zone before retrieval. Timestamps sent to the model are formatted in that local time zone. A request for the first message is answered directly from SQLite across all chats saved in this app, so the model cannot invent an earlier message or mislabel a UTC time as local time. Earlier sources are part of recalled context. The app has no access to conversations outside its own database.

At large history sizes, lookup is kept selective. Conversation pages use a `(created_at, id)` index and a cursor, so loading older chats does not scan or skip every previous page. Partial indexes cover the earliest user message and earliest question, both across all chats and inside one chat. Topic recall uses FTS5; date recall uses the local-date index and also intersects topic matches with the date, so a relevant message after the first 80 messages of a busy day can still be found. The model receives only a small set of excerpts. For a broad date-only request with more saved messages than fit in context, the prompt gives the total and tells the model to say the displayed set is partial.

In a local synthetic check with 400,000 chats and one user message per chat, the first two 50-chat pages took 1.2 ms and 0.7 ms, the first-message lookup took 0.5 ms, and a selective topic lookup took 40 ms. This measures database lookup only; a real answer also pays for Gemini and any web calls. Common terms and chats with many messages can cost more, so these figures are a sanity check rather than a latency guarantee.

The prompt explicitly separates earlier claims from current evidence. A current pricing page can establish the current price, but it cannot by itself prove that a historical price changed. The agent should say when the old value or date is missing. Live claims are linked to search result URLs, with preference for official pricing pages and release notes. Search snippets can be incomplete, so the user can inspect the linked page.

Gemini receives the last 12 turns and relevant older excerpts. Older excerpts have an 18,000-character budget; individual long messages are shortened from the middle so their beginning and conclusion remain available. The system instruction is concise and is reused through the search loop. Gemini 3.5 Flash-Lite uses minimal thinking for ordinary chat, low thinking for current-fact research, and medium thinking for multi-product change comparisons. The extra reasoning is spent where a false comparison would be more costly than a few additional tokens. The server logs Gemini's prompt, output, and thought token counts per answer so these limits can be tuned against challenge examples. Local tests verify behavior but cannot measure production token savings.

The server calls Gemini's `streamGenerateContent` endpoint and forwards text chunks to the browser as server-sent events. The browser updates a draft answer with a blinking cursor, then replaces it with the saved final answer. If Gemini requests web search after producing provisional text, the draft is cleared and search progress is shown. The server preserves the model's streamed parts, including thought signatures, when sending tool results back to Gemini.

## Tradeoffs and next improvements

- SQLite is local and durable, suitable for a single deployed instance. A multi-instance deployment would need shared storage and user authentication so recall stays scoped to the right person.
- Indexed date lookup and FTS5 are fast and require little extra stored data. Semantic recall could improve topic matching in long histories; it would add an embedding model and another index. The date parser covers the challenge's common phrases, but not every natural-language date expression.
- Tavily Extract returns query-relevant page chunks, not an unlimited copy of every page. Some sites cannot be extracted; a second independent provider or direct page reader could improve coverage at extra latency and complexity.
- The UI renders a limited Markdown subset and intentionally keeps the source URLs in the answer. A production client would use a vetted Markdown renderer and stronger citation validation.

## Run

Requires Node 22 or newer. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` and `TAVILY_API_KEY`. The default model is `gemini-3.5-flash-lite`; override it with `GEMINI_MODEL` if needed. Then run `npm install` and `npm run dev`. Nodemon restarts the server when `server.js`, `lib`, or `public` files change. Open `http://localhost:3000`.

The runtime uses Node's standard library; nodemon is a development dependency. Data is stored in `./data` by default. `APP_TIME_ZONE` controls the date used for relative-time questions.
