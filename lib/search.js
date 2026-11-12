const searchCache = new Map();
const cacheDurationMs = 2 * 60 * 1000;

export async function webSearch(query, { topic = 'general', days, domains = [] } = {}) {
  if (!process.env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is missing');
  if (typeof query !== 'string' || !query.trim()) throw new Error('Search query is empty');

  const cleanQuery = query.trim().replace(/\s+/g, ' ').slice(0, 350);
  const officialDomains = (Array.isArray(domains) ? domains : [])
    .map(domain => String(domain).replace(/^https?:\/\//, '').split('/')[0].toLowerCase())
    .filter(domain => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain))
    .slice(0, 3);
  const needsDetail = /\b(pricing|price|cost|plan|plans|changelog|release notes|changed|compare|comparison)\b/i
    .test(cleanQuery);
  const depth = needsDetail ? 'advanced' : 'basic';
  const cacheKey = JSON.stringify([cleanQuery.toLowerCase(), topic, days || null, depth, officialDomains]);
  const cachedSearch = searchCache.get(cacheKey);

  if (cachedSearch && cachedSearch.expires > Date.now()) {
    return cachedSearch.promise;
  }

  const promise = requestSearch(cleanQuery, { topic, days, depth, domains: officialDomains });
  searchCache.set(cacheKey, {
    promise,
    expires: Date.now() + cacheDurationMs
  });

  // A failed search should be retried next time, not kept in the cache.
  promise.catch(() => searchCache.delete(cacheKey));

  if (searchCache.size > 100) {
    for (const [key, value] of searchCache) {
      if (value.expires <= Date.now()) searchCache.delete(key);
    }
  }

  return promise;
}

async function requestSearch(query, { topic, days, depth, domains }) {
  const requestBody = {
    query,
    topic,
    search_depth: depth,
    max_results: depth === 'advanced' ? 5 : 4,
    include_raw_content: false,
    include_answer: false
  };
  if (domains.length > 0) requestBody.include_domains = domains;

  if (topic === 'news' && Number.isInteger(days) && days > 0) {
    requestBody.days = Math.min(days, 365);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Search provider returned ${response.status}`);
    }

    const data = await response.json();
    const uniqueResults = new Map();

    for (const result of data.results || []) {
      if (!result.url || uniqueResults.has(result.url)) continue;

      uniqueResults.set(result.url, {
        title: result.title,
        url: result.url,
        snippet: (result.content || '').replace(/\s+/g, ' ').slice(0, 900),
        published_at: result.published_date || null
      });
    }

    // Basic search is cheaper, but an empty result needs another try.
    if (uniqueResults.size === 0 && depth === 'basic') {
      return requestSearch(query, { topic, days, depth: 'advanced', domains });
    }

    return [...uniqueResults.values()];
  } finally {
    clearTimeout(timer);
  }
}

export async function extractPages(urls, question) {
  if (!process.env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is missing');
  if (typeof question !== 'string' || !question.trim()) {
    throw new Error('A focused question is needed to read pages');
  }

  const selectedUrls = [...new Set(urls)].slice(0, 3);
  if (selectedUrls.length === 0) throw new Error('No pages selected');

  for (const url of selectedUrls) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only web pages can be opened');
    }
  }

  const focus = question.trim().slice(0, 350);
  const needsTables = /\b(pricing|price|cost|plan|plans|table)\b/i.test(focus);
  const requestBody = {
    urls: selectedUrls,
    query: focus,
    chunks_per_source: needsTables ? 4 : 3,
    extract_depth: needsTables ? 'advanced' : 'basic',
    format: 'markdown',
    include_images: false
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32_000);

  try {
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Page extraction returned ${response.status}`);

    const data = await response.json();
    const pages = (data.results || []).map(result => ({
      url: result.url,
      content: (result.raw_content || '').slice(0, 4_000)
    }));
    const failures = (data.failed_results || []).map(result => ({
      url: result.url,
      error: result.error || 'Could not read this page'
    }));

    return { results: pages, failed_results: failures };
  } finally {
    clearTimeout(timer);
  }
}
