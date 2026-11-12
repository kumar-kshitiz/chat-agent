import { renderMarkdown } from './markdown.js';

const messagesElement = document.querySelector('#messages');
const inputElement = document.querySelector('#input');
const sendButton = document.querySelector('#send');
const conversationList = document.querySelector('#conversations');

let currentConversation = localStorage.getItem('minimi-conversation');
let isSending = false;
let nextConversationCursor = null;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(text) {
  const replacements = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  };
  return text.replace(/[&<>"']/g, character => replacements[character]);
}

function showMessage(role, text) {
  document.querySelector('.empty')?.remove();

  const article = document.createElement('article');
  article.className = `message ${role}`;

  if (role === 'user') {
    article.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  } else {
    article.innerHTML = `<div class="content">${renderMarkdown(text)}</div>`;
  }

  messagesElement.append(article);
  messagesElement.scrollTop = messagesElement.scrollHeight;
  return article;
}

function showWelcome() {
  messagesElement.innerHTML = `
    <div class="empty">
      <div class="orb">✳</div>
      <h1>What can I help you find?</h1>
      <p>Ask a question, revisit an old answer, or check what changed.</p>
      <div class="examples">
        <button>What did I ask you last week?</button>
        <button>What changed in Postgres hosting pricing recently?</button>
        <button>Compare the latest CRM pricing for a small sales team.</button>
      </div>
    </div>
  `;

  for (const button of document.querySelectorAll('.examples button')) {
    button.onclick = () => {
      inputElement.value = button.textContent;
      inputElement.focus();
    };
  }
}

async function refreshConversationList(loadMore = false) {
  const cursor = loadMore ? nextConversationCursor : null;
  const url = cursor ? `/api/conversations?cursor=${encodeURIComponent(cursor)}` : '/api/conversations';
  const page = await requestJson(url);
  if (!loadMore) conversationList.innerHTML = '';
  else conversationList.querySelector('.load-more')?.remove();

  for (const conversation of page.conversations) {
    const button = document.createElement('button');
    button.dataset.id = conversation.id;
    button.textContent = conversation.title;
    button.classList.toggle('active', conversation.id === currentConversation);
    button.onclick = () => openConversation(conversation.id);
    conversationList.append(button);
  }

  nextConversationCursor = page.nextCursor;
  if (nextConversationCursor) {
    const more = document.createElement('button');
    more.className = 'load-more';
    more.textContent = 'Load older chats';
    more.onclick = () => refreshConversationList(true);
    conversationList.append(more);
  }
}

async function openConversation(id) {
  const messages = await requestJson(`/api/conversations/${id}/messages`);

  currentConversation = id;
  localStorage.setItem('minimi-conversation', id);
  messagesElement.innerHTML = '';

  if (messages.length === 0) showWelcome();
  else for (const message of messages) showMessage(message.role, message.content);

  if (!conversationList.children.length) await refreshConversationList();
  for (const button of conversationList.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.id === id);
  }
  document.querySelector('.app').classList.remove('menu-open');
}

async function newConversation() {
  const conversation = await requestJson('/api/conversations', { method: 'POST' });
  await openConversation(conversation.id);
  await refreshConversationList();
  inputElement.focus();
}

async function readAnswer(response, statusElement) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let draft = null;
  let draftText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let separator;

    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const packet = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);

      const eventName = packet.match(/^event: (.+)$/m)?.[1];
      const eventData = packet.match(/^data: (.+)$/m)?.[1];
      if (!eventData) continue;

      const data = JSON.parse(eventData);

      if (eventName === 'status') statusElement.textContent = data.text;
      if (eventName === 'delta') {
        draftText += data.text;
        statusElement.hidden = true;

        if (!draft) {
          draft = showMessage('assistant', '');
          draft.classList.add('streaming');
        }

        draft.querySelector('.content').innerHTML = renderMarkdown(draftText);
        messagesElement.scrollTop = messagesElement.scrollHeight;
      }
      if (eventName === 'reset') {
        draft?.remove();
        draft = null;
        draftText = '';
        statusElement.hidden = false;
      }
      if (eventName === 'answer') {
        statusElement.remove();
        if (draft) {
          draft.classList.remove('streaming');
          draft.querySelector('.content').innerHTML = renderMarkdown(data.text);
        } else {
          showMessage('assistant', data.text);
        }
      }
      if (eventName === 'error') throw new Error(data.error);
    }
  }
}

async function sendMessage(text) {
  if (isSending || !text.trim()) return;

  isSending = true;
  sendButton.disabled = true;
  inputElement.value = '';
  showMessage('user', text);

  const statusElement = document.createElement('div');
  statusElement.className = 'status';
  statusElement.textContent = 'Thinking…';
  messagesElement.append(statusElement);

  try {
    if (!currentConversation) {
      const conversation = await requestJson('/api/conversations', { method: 'POST' });
      currentConversation = conversation.id;
      localStorage.setItem('minimi-conversation', currentConversation);
    }

    const response = await fetch(`/api/conversations/${currentConversation}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Request failed');
    }

    await readAnswer(response, statusElement);
    await refreshConversationList();
  } catch (error) {
    statusElement.hidden = false;
    if (!statusElement.isConnected) messagesElement.append(statusElement);
    statusElement.classList.add('error');
    statusElement.textContent = error.message;
  } finally {
    isSending = false;
    sendButton.disabled = false;
    inputElement.focus();
  }
}

document.querySelector('#composer').onsubmit = event => {
  event.preventDefault();
  sendMessage(inputElement.value);
};

inputElement.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    document.querySelector('#composer').requestSubmit();
  }
};

document.querySelector('#new').onclick = newConversation;
document.querySelector('#menu').onclick = () => {
  document.querySelector('.app').classList.toggle('menu-open');
};

if (currentConversation) {
  openConversation(currentConversation).catch(() => {
    currentConversation = null;
    localStorage.removeItem('minimi-conversation');
    showWelcome();
    refreshConversationList();
  });
} else {
  showWelcome();
  refreshConversationList();
}
