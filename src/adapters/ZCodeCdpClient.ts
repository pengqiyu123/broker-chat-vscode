// ZCode CDP 客户端：通过 Chrome DevTools Protocol 往 ZCode 输入框注入文本并触发提交。
//
// 背景：app-server 的 session/send 只追加历史、不触发 AI 回复（实测确认）；
// 合成键盘事件（SendInput/WScript.SendKeys）被 ZCode 拦截（物理键盘能进，合成的不行）；
// 唯一可靠路径是 CDP——直接操作 DOM，绕过键盘事件层。实测：写入 [data-testid="chat-input"]
// 的 contenteditable + dispatch input 事件 + 点击「加入队列」按钮，AI 会真正开始回复。
//
// 前提：ZCode 必须带 --remote-debugging-port=9224 启动（见 BrokerController.ensureZcodeWithDebugPort）。

const CDP_PORT = 9224;
const CDP_HOST = "127.0.0.1";

interface CdpPage {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

interface CdpResponse {
  id: number;
  result?: { result?: { value?: unknown } };
  error?: { message: string };
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CDP HTTP ${resp.status}: ${url}`);
  }
  return resp.json();
}

// 找 ZCode 主渲染页面的 webSocketDebuggerUrl（url 含 renderer/index.html）。
export async function findZCodeCdpTarget(): Promise<string> {
  const pages = (await fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json`)) as CdpPage[];
  const main = pages.find((p) => p.type === "page" && p.url.includes("renderer/index.html"));
  if (!main || !main.webSocketDebuggerUrl) {
    throw new Error("ZCode CDP 主页面未找到（url 含 renderer/index.html 的 page）");
  }
  return main.webSocketDebuggerUrl;
}

// 探测 CDP 端口是否可用（健康检查用，不开长连）。
export async function isCdpReachable(): Promise<boolean> {
  try {
    await fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
    return true;
  } catch {
    return false;
  }
}

// 向输入框注入文本并触发提交。返回提交是否成功（输入框被清空 = 提交成功）。
export async function cdpSendToZCodeInput(text: string, timeoutMs = 10000): Promise<void> {
  const target = await findZCodeCdpTarget();
  const ws = new WebSocket(target);
  let msgId = 0;
  const pending = new Map<number, (resp: CdpResponse) => void>();

  const evalJs = (expr: string): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (resp: CdpResponse) => {
      if (resp.error) {
        reject(new Error(`CDP eval error: ${resp.error.message}`));
      } else {
        resolve(resp.result?.result?.value);
      }
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  });

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error("CDP 注入超时"));
    }, timeoutMs);

    ws.addEventListener("open", async () => {
      try {
        // 1. 注入文本到 contenteditable 输入框
        const injectExpr = `(() => {
          const el = document.querySelector('[data-testid="chat-input"]');
          if (!el) return JSON.stringify({ ok: false, msg: 'no input element' });
          el.focus();
          el.textContent = ${JSON.stringify(text)};
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
          return JSON.stringify({ ok: true });
        })()`;
        const injectResult = await evalJs(injectExpr);
        const parsed = JSON.parse(String(injectResult ?? "{}"));
        if (!parsed.ok) {
          throw new Error(`输入框注入失败: ${parsed.msg ?? "未知"}`);
        }

        // 2. 等待 React 更新（提交按钮出现）
        await new Promise((r) => setTimeout(r, 600));

        // 3. 点击「加入队列」按钮（form 内最后一个按钮，aria-label 含 队列/send/发送）
        const submitExpr = `(() => {
          const el = document.querySelector('[data-testid="chat-input"]');
          const form = el.closest('form');
          if (!form) return JSON.stringify({ ok: false, msg: 'no form' });
          const btns = Array.from(form.querySelectorAll('button'));
          let btn = btns.find(b => /队列|send|发送|提交/i.test(b.getAttribute('aria-label')||'') || /队列|发送|提交/i.test(b.textContent||''));
          if (!btn) btn = btns[btns.length - 1];
          if (!btn) return JSON.stringify({ ok: false, msg: 'no submit button' });
          btn.click();
          setTimeout(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })), 50);
          return JSON.stringify({ ok: true, aria: btn.getAttribute('aria-label') });
        })()`;
        const submitResult = await evalJs(submitExpr);
        const submitParsed = JSON.parse(String(submitResult ?? "{}"));
        if (!submitParsed.ok) {
          throw new Error(`提交失败: ${submitParsed.msg ?? "未知"}`);
        }

        // 4. 等输入框清空，确认提交生效
        await new Promise((r) => setTimeout(r, 1500));
        const checkExpr = `(() => {
          const el = document.querySelector('[data-testid="chat-input"]');
          return JSON.stringify({ empty: (el.textContent || '').trim() === '' });
        })()`;
        const checkResult = await evalJs(checkExpr);
        const checkParsed = JSON.parse(String(checkResult ?? "{}"));

        clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        if (!checkParsed.empty) {
          // 输入框没清空，可能提交没生效，但不一定是错误（某些状态下按钮行为不同）
          // 视为警告但不 throw——让上层通过会话轮询判断
        }
        resolve();
      } catch (err) {
        clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        reject(err);
      }
    });

    ws.addEventListener("message", (ev) => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const cb = pending.get(msg.id)!;
        pending.delete(msg.id);
        cb(msg);
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket 连接失败"));
    });
  });
}
