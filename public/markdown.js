// This small renderer covers the Markdown used in chat answers.
// Escaping happens before formatting so model output cannot add HTML directly.
function escapeHtml(text) {
  const replacements = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  };
  return text.replace(/[&<>"']/g, character => replacements[character]);
}

function renderInline(text) {
  const savedHtml = [];

  function save(html) {
    const index = savedHtml.push(html) - 1;
    return `\u0000${index}\u0000`;
  }

  let result = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return label;

      const safeUrl = escapeHtml(parsed.href);
      const safeLabel = escapeHtml(label);
      return save(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`);
    } catch {
      return label;
    }
  });

  result = result.replace(/`([^`]+)`/g, (_, code) => {
    return save(`<code>${escapeHtml(code)}</code>`);
  });

  result = escapeHtml(result);
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  return result.replace(/\u0000(\d+)\u0000/g, (_, index) => savedHtml[Number(index)]);
}

function isBlockStart(line) {
  return /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|---+\s*$)/.test(line);
}

export function renderMarkdown(input) {
  // Some model answers escape headings and bullets. Remove that one backslash.
  const lines = input.replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/^(\s*)\\(?=#{1,6}\s|\*\s)/, '$1'));

  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    if (/^\s*```\w*\s*$/.test(line)) {
      index++;
      const codeLines = [];

      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index++;
      }

      if (index < lines.length) index++;
      output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      output.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index++;
      continue;
    }

    const listItem = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const isNumbered = /^\d/.test(listItem[1]);
      const tag = isNumbered ? 'ol' : 'ul';
      const items = [];

      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== isNumbered) break;

        items.push(`<li>${renderInline(item[2])}</li>`);
        index++;
      }

      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];

      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index++;
      }

      output.push(`<blockquote><p>${quoteLines.map(renderInline).join('<br>')}</p></blockquote>`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      output.push('<hr>');
      index++;
      continue;
    }

    const paragraphLines = [];

    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index++;
    }

    if (paragraphLines.length > 0) {
      output.push(`<p>${paragraphLines.map(renderInline).join('<br>')}</p>`);
    } else {
      index++;
    }
  }

  return output.join('');
}
