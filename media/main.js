(function () {
  const vscode = acquireVsCodeApi();
  const PREVIEW_MESSAGE_COUNT = 4;
  const TIMELINE_MESSAGE_COUNT = 12;
  const elements = {
    refreshButton: document.getElementById("refreshButton"),
    summary: document.getElementById("summary"),
    codexSession: document.getElementById("codexSession"),
    claudeSession: document.getElementById("claudeSession"),
    codexPreview: document.getElementById("codexPreview"),
    claudePreview: document.getElementById("claudePreview"),
    mergedTimeline: document.getElementById("mergedTimeline")
  };

  let snapshot = {
    workspaceCwd: "",
    currentTarget: "codex",
    busy: false,
    autoDebate: {
      active: false,
      rounds: 1,
      returnMode: "compact",
      startTarget: "codex",
      currentStep: 0,
      totalSteps: 0
    },
    monitor: {
      enabled: true,
      lastUpdated: 0
    },
    bridge: {
      busy: false
    }
  };
  let lastRenderSignature = "";
  let queuedSnapshot = null;
  const bridgeNoteDrafts = new Map();
  let deferredRenderTimer = null;

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) {
      return "未读取";
    }

    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSeconds < 5) {
      return "刚刚";
    }
    if (diffSeconds < 60) {
      return `${diffSeconds} 秒前`;
    }
    if (diffSeconds < 3600) {
      return `${Math.floor(diffSeconds / 60)} 分钟前`;
    }
    return `${Math.floor(diffSeconds / 3600)} 小时前`;
  }

  function getRenderSignature(nextSnapshot) {
    const monitor = nextSnapshot.monitor || {};
    const stableBridge = nextSnapshot.bridge
      ? {
          busy: nextSnapshot.bridge.busy,
          target: nextSnapshot.bridge.target,
          source: nextSnapshot.bridge.source,
          mode: nextSnapshot.bridge.mode,
          message: nextSnapshot.bridge.message,
          error: nextSnapshot.bridge.error
        }
      : { busy: false };

    return JSON.stringify({
      workspaceCwd: nextSnapshot.workspaceCwd,
      currentTarget: nextSnapshot.currentTarget,
      busy: nextSnapshot.busy,
      autoDebate: nextSnapshot.autoDebate,
      bridge: stableBridge,
      monitor: {
        enabled: monitor.enabled,
        codexError: monitor.codexError,
        claudeError: monitor.claudeError,
        codex: monitor.codex || null,
        claude: monitor.claude || null
      }
    });
  }

  function shouldDeferRender() {
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && selection.toString().trim()) {
      return true;
    }

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLInputElement ||
      (activeElement && activeElement.isContentEditable)
    ) {
      return true;
    }

    return false;
  }

  function scheduleDeferredRender() {
    if (deferredRenderTimer) {
      window.clearTimeout(deferredRenderTimer);
    }

    deferredRenderTimer = window.setTimeout(() => {
      if (!queuedSnapshot || shouldDeferRender()) {
        scheduleDeferredRender();
        return;
      }

      deferredRenderTimer = null;
      lastRenderSignature = getRenderSignature(queuedSnapshot);
      applySnapshot(queuedSnapshot);
      queuedSnapshot = null;
    }, 250);
  }

  function applySnapshot(nextSnapshot) {
    snapshot = nextSnapshot;
    render();
  }

  function renderSessionCard(session, error, agentLabel) {
    if (error) {
      return `<div class="session-error">${escapeHtml(error)}</div>`;
    }

    if (!session) {
      return `<div class="session-empty">当前项目暂无 ${escapeHtml(agentLabel)} 官方会话</div>`;
    }

    return `
      <div class="session-title">${escapeHtml(session.title)}</div>
      <div class="session-meta">会话 ID: ${escapeHtml(session.sessionId)}</div>
      <div class="session-meta">消息数: ${escapeHtml(session.messageCount)}</div>
      <div class="session-meta">更新: ${escapeHtml(formatRelativeTime(session.updatedAt))}</div>
      <div class="session-path" title="${escapeHtml(session.sourcePath)}">${escapeHtml(session.sourcePath)}</div>
      ${session.cwd ? `<div class="session-cwd" title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</div>` : ""}
    `;
  }

  function findAdjacentUserMessage(session, messageIndex) {
    if (!session || !Array.isArray(session.messages)) {
      return null;
    }

    const candidate = session.messages[messageIndex - 1];
    if (candidate && candidate.role === "user" && candidate.text && candidate.text.trim()) {
      return candidate;
    }

    return null;
  }

  function renderBridgeActions(session, message, messageIndex) {
    if (!session || !message || message.role !== session.agent) {
      return "";
    }

    const mergeCandidate = findAdjacentUserMessage(session, messageIndex);
    const targetLabel = session.agent === "codex" ? "Claude" : "Codex";
    const mergeButton = mergeCandidate
      ? `<button
          class="action-button"
          data-bridge-send="true"
          data-source-agent="${escapeHtml(session.agent)}"
          data-session-id="${escapeHtml(session.sessionId)}"
          data-message-id="${escapeHtml(message.id)}"
          data-mode="merge-forward"
        >合并转发到 ${escapeHtml(targetLabel)}</button>`
      : "";

    const noteValue = escapeHtml(bridgeNoteDrafts.get(message.id) || "");

    return `<div class="action-row">
      ${mergeButton}
      <button
        class="action-button secondary"
        data-bridge-send="true"
        data-source-agent="${escapeHtml(session.agent)}"
        data-session-id="${escapeHtml(session.sessionId)}"
        data-message-id="${escapeHtml(message.id)}"
        data-mode="forward-answer"
      >仅转发这条回答</button>
    </div>
    <div class="bridge-note-row">
      <textarea
        class="bridge-note-input"
        data-note-message-id="${escapeHtml(message.id)}"
        rows="2"
        placeholder="可选：补充一句说明，再和这条一起发送"
      >${noteValue}</textarea>
    </div>`;
  }

  function renderMessageCard(entry, options) {
    const message = entry.message;
    const session = entry.session;
    const textBlock = message.text
      ? `<pre class="message-text">${escapeHtml(message.text)}</pre>`
      : "";
    const actions = options.includeActions ? renderBridgeActions(session, message, entry.messageIndex) : "";
    const origin = options.showOrigin
      ? `<span class="origin-chip ${escapeHtml(session.agent)}">${escapeHtml(session.agent)}</span>`
      : "";
    const compactClass = options.compact ? " compact" : "";

    return `<article class="message role-${message.role}${compactClass}">
      <div class="message-header">
        <div class="header-left">
          <span class="badge">${escapeHtml(message.role)}</span>
          ${origin}
        </div>
        <span class="timestamp">${new Date(message.createdAt).toLocaleTimeString()}</span>
      </div>
      ${textBlock}
      ${actions}
    </article>`;
  }

  function getRecentEntries(session, count) {
    if (!session || !Array.isArray(session.messages) || session.messages.length === 0) {
      return [];
    }

    const startIndex = Math.max(0, session.messages.length - count);
    return session.messages.slice(startIndex).map((message, messageIndexOffset) => ({
      session,
      message,
      messageIndex: startIndex + messageIndexOffset
    }));
  }

  function getCombinedEntries(monitor) {
    const sessions = [monitor.codex, monitor.claude].filter(Boolean);
    const entries = [];

    sessions.forEach((session) => {
      session.messages.forEach((message, messageIndex) => {
        entries.push({
          session,
          message,
          messageIndex
        });
      });
    });

    entries.sort((left, right) => {
      if (left.message.createdAt !== right.message.createdAt) {
        return left.message.createdAt - right.message.createdAt;
      }
      if (left.session.agent !== right.session.agent) {
        return left.session.agent.localeCompare(right.session.agent);
      }
      return left.messageIndex - right.messageIndex;
    });

    return entries.slice(-TIMELINE_MESSAGE_COUNT);
  }

  function renderPreview(entries) {
    if (!entries.length) {
      return `<div class="message-empty">暂无消息</div>`;
    }

    return entries
      .map((entry) =>
        renderMessageCard(entry, {
          includeActions: false,
          showOrigin: false,
          compact: true
        })
      )
      .join("");
  }

  function renderMergedTimeline(entries) {
    if (!entries.length) {
      return `<div class="message-empty">暂无可显示的清洗后消息</div>`;
    }

    return entries
      .map((entry) =>
        renderMessageCard(entry, {
          includeActions: true,
          showOrigin: true,
          compact: false
        })
      )
      .join("");
  }

  function render() {
    const monitor = snapshot.monitor || {};
    const bridge = snapshot.bridge || {};
    const bridgeDetail = bridge.error || bridge.message || "等待操作";
    const bridgeState = bridge.busy ? "发送中" : bridge.error ? "失败" : bridge.message ? "已完成" : "待命";
    const workspaceCwd = snapshot.workspaceCwd || "";
    const projectName = workspaceCwd ? workspaceCwd.split(/[/\\]/).pop() : "未知项目";
    const codexPreviewEntries = getRecentEntries(monitor.codex, PREVIEW_MESSAGE_COUNT);
    const claudePreviewEntries = getRecentEntries(monitor.claude, PREVIEW_MESSAGE_COUNT);
    const mergedEntries = getCombinedEntries(monitor);

    elements.summary.innerHTML = `
      <div class="summary-card">
        <div class="summary-label">监控状态</div>
        <div class="summary-value">${monitor.enabled ? "运行中" : "已关闭"}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">当前项目</div>
        <div class="summary-value">${escapeHtml(projectName)}</div>
        <div class="summary-note">${escapeHtml(workspaceCwd)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">桥接状态</div>
        <div class="summary-value">${escapeHtml(bridgeState)}</div>
        <div class="summary-note">${escapeHtml(bridgeDetail)}</div>
      </div>
    `;

    elements.codexSession.innerHTML = renderSessionCard(monitor.codex, monitor.codexError, "Codex");
    elements.claudeSession.innerHTML = renderSessionCard(monitor.claude, monitor.claudeError, "Claude");
    elements.codexPreview.innerHTML = renderPreview(codexPreviewEntries);
    elements.claudePreview.innerHTML = renderPreview(claudePreviewEntries);
    elements.mergedTimeline.innerHTML = renderMergedTimeline(mergedEntries);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "snapshot" && message.snapshot) {
      const nextSignature = getRenderSignature(message.snapshot);
      if (nextSignature === lastRenderSignature) {
        snapshot = message.snapshot;
        return;
      }

      if (shouldDeferRender()) {
        queuedSnapshot = message.snapshot;
        scheduleDeferredRender();
        return;
      }

      lastRenderSignature = nextSignature;
      applySnapshot(message.snapshot);
    }
  });

  elements.refreshButton.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh-monitor" });
  });

  document.body.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-bridge-send='true']") : null;
    if (!button) {
      return;
    }

    const container = button.closest(".message");
    const extraTextInput = container ? container.querySelector(".bridge-note-input") : null;
    const extraText = extraTextInput instanceof HTMLTextAreaElement ? extraTextInput.value : "";

    vscode.postMessage({
      type: "bridge-send",
      sourceAgent: button.getAttribute("data-source-agent"),
      sessionId: button.getAttribute("data-session-id"),
      messageId: button.getAttribute("data-message-id"),
      mode: button.getAttribute("data-mode"),
      extraText
    });
  });

  document.body.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }

    if (!target.classList.contains("bridge-note-input")) {
      return;
    }

    const messageId = target.getAttribute("data-note-message-id");
    if (!messageId) {
      return;
    }

    bridgeNoteDrafts.set(messageId, target.value);
  });

  document.addEventListener("selectionchange", () => {
    if (!queuedSnapshot || shouldDeferRender()) {
      return;
    }

    const nextSignature = getRenderSignature(queuedSnapshot);
    lastRenderSignature = nextSignature;
    applySnapshot(queuedSnapshot);
    queuedSnapshot = null;
  });

  vscode.postMessage({ type: "ready" });
})();
