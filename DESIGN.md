# Design: chat agent with web search

## What this app does

The agent answers ordinary questions, remembers conversations saved in this app, and checks the web when facts may have changed. For example:

> “Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?”

That question needs two kinds of evidence: the earlier conversation and current pricing pages. The agent retrieves both before answering. It only claims that a price **changed** when it has evidence for the old and new prices.

## The main pieces

| Part | Job |
| --- | --- |
| Browser (`public/`) | Shows chats and streams the answer as it arrives. |
| Node server (`server.js`) | Handles requests, saves messages, and sends answer updates. |
| Agent (`lib/agent.js`) | Builds context, calls Gemini, and handles its web-search requests. |
| Search (`lib/search.js`) | Searches with Tavily and reads selected result pages. |
| Store (`lib/store.js`) | Saves chats in SQLite and finds older messages. |
| Dates (`lib/dates.js`) | Turns phrases such as “last Tuesday” into local calendar dates. |

```text
User → Browser → Node server → Agent → Gemini
                         │          │
                         │          └→ web_search → Tavily
                         └→ SQLite chat history
```

Gemini has one callable tool: `web_search`. A tool call can search for results or read a few URLs returned by an earlier search.

## Workflow 1: an ordinary message

```text
1. The browser sends the message to the server.
2. The server saves it in SQLite.
3. The agent includes the recent conversation and useful older messages.
4. Gemini writes an answer, asking for web search if needed.
5. Answer chunks appear in the browser as Gemini sends them.
6. The final answer and its source URLs are saved in SQLite.
```

The server sends updates through Server-Sent Events (SSE). If Gemini starts writing and then requests a search, the browser clears that draft, shows search progress, and streams the final answer afterward.

## Workflow 2: remembering an older chat

For “What did I ask on 3 November?”, the agent follows this path:

```text
Question → resolve “3 November” in APP_TIME_ZONE
         → find messages saved on that local date
         → give relevant messages and local timestamps to Gemini
         → answer from the saved record
```

The server stores each message's UTC timestamp **and** its date in the configured local time zone. This makes date lookup direct and prevents a UTC timestamp from being presented as an IST time. If a year is missing, the date parser uses the most recent occurrence of that date.

For topic questions such as “What did I ask about Postgres?”, SQLite's full-text search (FTS5) finds matching messages across saved chats. A question with both a date and a topic uses both clues. Recent messages are sent directly, so they do not need a search.

“What was my first question overall?” takes a shorter path: the server reads the earliest saved user message directly from SQLite and formats its local time. This avoids asking the model to guess. “Overall” means all conversations in **this app's database**; this app cannot read other ChatGPT accounts or unrelated chat services.

## Workflow 3: checking what changed

For “Has any Postgres hosting pricing changed since last Tuesday?”, the agent:

```text
1. Finds Tuesday's saved discussion and the products it mentioned.
2. Asks Gemini to search for current pricing for those products.
3. Returns search results with titles, snippets, dates, and URLs.
4. Reads relevant pricing pages if snippets lack exact prices.
5. Compares the earlier and current evidence.
6. Answers with links and states where a comparison cannot be proven.
```

A current pricing page establishes a current price. By itself, it does not establish the earlier price. When the earlier price was not saved or cannot be verified, the agent should say so.

### How `web_search` works

- Gemini supplies a focused query, or a batch of up to six queries for several products. The server runs batch searches in parallel and sends two results per query back to Gemini.
- Pricing-change searches require a company website domain. The server passes that filter to Tavily, so broad comparison sites do not replace the provider's own pages.
- A single search returns up to four basic or five advanced results.
- Pricing, cost, comparison, and release-note queries use advanced search. An empty basic search gets one advanced retry.
- Results are deduplicated by URL, and each snippet is limited to 900 characters.
- Gemini can ask to read up to three URLs from earlier search results. Tavily Extract returns a few relevant page chunks; pricing pages use deeper extraction to capture tables.
- Up to six tool calls can run together in a model round. The agent allows five tool rounds, then one final answer round with further tool calls disabled.
- Repeated identical searches share an in-flight request and a two-minute cache. Failures are returned to Gemini so it can explain the gap.

Questions about current facts force an initial web search. If a researched final answer has no source link, the agent asks Gemini once to revise it with citations.

Reading pages only when snippets are insufficient keeps most answers faster and reduces Tavily usage and model input.

## How history stays usable as it grows

The agent never sends the entire database to Gemini. It sends the last 12 messages plus selected older excerpts, with an 18,000-character limit for those excerpts. Long messages are shortened while keeping their beginning and end.

| Lookup | How it stays selective |
| --- | --- |
| Recent chat | Read the latest messages by conversation ID. |
| A named day or week | Use the indexed local date. |
| A topic across chats | Use SQLite FTS5. |
| First message or first question | Use dedicated indexes on user messages. |
| Older chat list | Load 50 at a time using an indexed cursor. |

If a day has more messages than can fit in the prompt, the agent gets the total count and is told to describe the shown messages as a partial set. Date plus topic lookup can still find a relevant message beyond the first page of that day.

In a **local synthetic check** with 400,000 chats and one user message per chat, the first two 50-chat pages took 1.2 ms and 0.7 ms, the first-message lookup took 0.5 ms, and a selective topic lookup took about 40 ms. These measure SQLite lookup only. Common search terms, larger chats, Gemini, and web calls can take longer.

## Token and latency choices

- Gemini 3.5 Flash-Lite is the default model. The thinking level is minimal for ordinary chat, low for current-fact research, and medium for multi-product change comparisons.
- The agent limits history, snippets, extracted page text, search results, and search rounds before sending them to Gemini. Batch search results use shorter snippets than single searches.
- Gemini streams text to the browser, so users can read while the answer is being generated.
- The server logs Gemini prompt, output, and thought token counts for each answer. Local tests check behavior; they do not prove production token savings.

## Run and test

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env
# Add GEMINI_API_KEY and TAVILY_API_KEY to .env
npm run dev
```

Open `http://localhost:3000`. Nodemon restarts the server after code changes. Use `npm test` for the local tests. Chat data is created in `./data` by default and is ignored by Git. `APP_TIME_ZONE` controls how relative dates and displayed timestamps are interpreted.
