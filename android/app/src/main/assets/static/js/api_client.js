/**
 * SmartLocalNote - Unified API & SSE Client
 * Expects unified backend JSON envelope: { ok: boolean, data: any, message: string }
 */

/**
 * Unified fetch wrapper.
 * @param {string} path
 * @param {RequestInit & { raw?: boolean }} [options]
 * @returns {Promise<any>}
 */
export async function apiRequest(path, options = {}) {
  const { raw = false, headers: customHeaders, body, ...rest } = options;
  const headers = new Headers(customHeaders || {});

  let finalBody = body;
  if (
    body !== undefined &&
    body !== null &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(body) &&
    typeof body === 'object'
  ) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    finalBody = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...rest,
      headers,
      body: finalBody,
    });
  } catch (err) {
    throw new Error(`网络请求失败：${err?.message || '无法连接本地服务'}`);
  }

  if (raw) {
    if (!response.ok) {
      throw new Error(`请求失败 (${response.status})`);
    }
    return response;
  }

  let payload = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    return text;
  }

  if (!response.ok) {
    const msg = payload?.message || payload?.detail || `HTTP ${response.status}`;
    throw new Error(msg);
  }

  if (payload && typeof payload === 'object' && 'ok' in payload) {
    if (!payload.ok) {
      throw new Error(payload.message || '操作失败');
    }
    return payload.data;
  }

  return payload;
}

export function expandFileContent({ path, page, sheet, cell, member } = {}) {
  const params = new URLSearchParams();
  if (path !== undefined && path !== null && path !== '') params.set('path', String(path));
  if (page !== undefined && page !== null && page !== '') params.set('page', String(page));
  if (sheet !== undefined && sheet !== null && sheet !== '') params.set('sheet', String(sheet));
  if (cell !== undefined && cell !== null && cell !== '') params.set('cell', String(cell));
  if (member !== undefined && member !== null && member !== '') params.set('member', String(member));
  return apiRequest(`/api/files/expand-content?${params.toString()}`, { method: 'GET' });
}

export function seedTestSuite({ reset = true } = {}) {
  return apiRequest('/api/system/seed-test-suite', {
    method: 'POST',
    body: { reset: Boolean(reset) },
  });
}

export const api = {
  get(url, options = {}) {
    return apiRequest(url, { ...options, method: 'GET' });
  },
  post(url, body, options = {}) {
    return apiRequest(url, { ...options, method: 'POST', body });
  },
  put(url, body, options = {}) {
    return apiRequest(url, { ...options, method: 'PUT', body });
  },
  patch(url, body, options = {}) {
    return apiRequest(url, { ...options, method: 'PATCH', body });
  },
  del(url, body, options = {}) {
    return apiRequest(url, { ...options, method: 'DELETE', body });
  },
  expandFileContent,
  seedTestSuite,
};

/**
 * Stream POST SSE responses (e.g. /api/ai/chat).
 * Supports `data: {...}` and `data: [DONE]` lines.
 */
export async function streamPostSSE(url, body, { onChunk, onDone, onError, signal } = {}) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body ?? {}),
      signal,
    });

    if (!response.ok) {
      let msg = `SSE 请求失败 (${response.status})`;
      try {
        const errJson = await response.json();
        if (errJson?.message) msg = errJson.message;
      } catch {
        // ignore non-json error body
      }
      const httpErr = new Error(msg);
      httpErr.status = response.status;
      throw httpErr;
    }

    if (!response.body) {
      throw new Error('当前环境不支持流式响应');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finished = false;

    const processLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const dataStr = line.slice(5).trim();
      if (!dataStr) return;
      if (dataStr === '[DONE]') {
        finished = true;
        onDone?.();
        return;
      }
      let parsed = dataStr;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        // pass raw text chunk if not JSON
      }
      if (parsed && typeof parsed === 'object' && parsed.error) {
        throw new Error(parsed.error);
      }
      onChunk?.(parsed);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
        if (finished) return;
      }
    }

    if (buffer.trim()) {
      processLine(buffer);
    }
    if (!finished) {
      onDone?.();
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      onDone?.({ aborted: true });
      return;
    }
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Connect to backend EventSource('/api/events') with graceful backoff reconnect.
 * Silently degrades if the endpoint returns 404 during early stages.
 * @param {(event: { type: string, data: any }) => void} onEvent
 * @returns {() => void} disconnect function
 */
export function connectEventStream(onEvent) {
  let closed = false;
  let source = null;
  let retryDelay = 2000;
  let retryTimer = null;

  const scheduleReconnect = async () => {
    if (closed) return;
    // Probe once gently to detect Stage 1 404 without spamming console
    try {
      const probe = await fetch('/api/events', { method: 'HEAD' });
      if (probe.status === 404) {
        retryDelay = Math.min(retryDelay * 2, 30000);
        retryTimer = window.setTimeout(connect, retryDelay);
        return;
      }
    } catch {
      // network offline, retry with backoff
    }
    retryTimer = window.setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 20000);
  };

  const handleParsed = (type, rawData) => {
    let data = rawData;
    if (typeof rawData === 'string') {
      try {
        data = JSON.parse(rawData);
      } catch {
        // keep string
      }
    }
    onEvent?.({ type, data });
  };

  const connect = () => {
    if (closed || typeof EventSource === 'undefined') return;
    try {
      source = new EventSource('/api/events');
    } catch {
      scheduleReconnect();
      return;
    }

    source.onopen = () => {
      retryDelay = 2000;
    };

    source.onmessage = (evt) => {
      handleParsed('message', evt.data);
    };

    const namedEvents = ['reminder:fired', 'snapshot:created', 'clipboard:sniff', 'system:alert'];
    for (const evtName of namedEvents) {
      source.addEventListener(evtName, (evt) => {
        handleParsed(evtName, evt.data);
      });
    }

    source.onerror = () => {
      if (source) {
        source.close();
        source = null;
      }
      if (!closed) {
        scheduleReconnect();
      }
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    if (source) source.close();
  };
}
