(function () {
  const vscode = acquireVsCodeApi();
  const PREVIEW_MESSAGE_COUNT = 4;
  const TIMELINE_MESSAGE_COUNT = 12;
  const DEFAULT_AUTO_FORWARD_KEYWORDS = {
    codex: [
      "给Codex命令",
      "给codex命令",
      "发送给codex",
      "发给codex",
      "转给codex",
      "转发给codex",
      "问codex",
      "给 Codex",
      "发送给 Codex",
      "发给 Codex",
      "转给 Codex",
      "转发给 Codex",
      "问 Codex"
    ],
    claude: [
      "回复ClaudeCode",
      "回复claudecode",
      "给ClaudeCode命令",
      "给claudecode命令",
      "发送给claude",
      "发给claude",
      "转给claude",
      "转发给claude",
      "问claude",
      "给 Claude",
      "发送给 Claude",
      "发给 Claude",
      "转给 Claude",
      "转发给 Claude",
      "问 Claude"
    ]
  };
  const DEFAULT_DIRECTIONAL_ROLE_PREFIXES = {
    claudeToCodex:
      "身份锁定：你是Codex，首席开发负责人，统领多智能体开发小组，负责全部代码实现。\n上级对接：ClaudeCode为本项目产品经理，只下发开发指令、验收成果、提出修改意见，你严格按照ClaudeCode的指令开发。",
    codexToClaude:
      "身份：你是ClaudeCode，本项目专职产品经理，统筹多智能体开发项目，不编写代码，只拆解需求、输出开发指令、验收Codex开发成果、下发整改要求。\n协作关系：Codex为首席开发主管，带队多智能体团队编码落地，严格按你的指令开发。"
  };
  const elements = {
    logsButton: document.getElementById("logsButton"),
    refreshButton: document.getElementById("refreshButton"),
    settingsButton: document.getElementById("settingsButton"),
    settingsPanel: document.getElementById("settingsPanel"),
    statusBar: document.getElementById("statusBar"),
    statusDetail: document.getElementById("statusDetail"),
    autoForwardToggle: document.getElementById("autoForwardToggle"),
    codexKeywords: document.getElementById("codexKeywords"),
    claudeKeywords: document.getElementById("claudeKeywords"),
    saveKeywordsButton: document.getElementById("saveKeywordsButton"),
    resetKeywordsButton: document.getElementById("resetKeywordsButton"),
    claudeToCodexPrefix: document.getElementById("claudeToCodexPrefix"),
    codexToClaudePrefix: document.getElementById("codexToClaudePrefix"),
    saveRolePrefixesButton: document.getElementById("saveRolePrefixesButton"),
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
    },
    autoForward: {
      enabled: true,
      status: "idle",
      keywords: DEFAULT_AUTO_FORWARD_KEYWORDS
    },
    directionalRolePrefixes: DEFAULT_DIRECTIONAL_ROLE_PREFIXES
  };
  let lastRenderSignature = "";
  let queuedSnapshot = null;
  const bridgeNoteDrafts = new Map();
  let deferredRenderTimer = null;
  let settingsOpen = false;
  let keywordDraftTouched = false;
  let rolePrefixDraftTouched = false;

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
      autoForward: nextSnapshot.autoForward,
      directionalRolePrefixes: nextSnapshot.directionalRolePrefixes,
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

  function getAutoForwardKeywords() {
    const autoForward = snapshot.autoForward || {};
    const keywords = autoForward.keywords || DEFAULT_AUTO_FORWARD_KEYWORDS;
    return {
      codex: Array.isArray(keywords.codex) ? keywords.codex : DEFAULT_AUTO_FORWARD_KEYWORDS.codex,
      claude: Array.isArray(keywords.claude) ? keywords.claude : DEFAULT_AUTO_FORWARD_KEYWORDS.claude
    };
  }

  function keywordsToText(keywords) {
    return keywords.join("\n");
  }

  function textToKeywords(value) {
    return String(value)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function getDirectionalRolePrefixes() {
    const prefixes = snapshot.directionalRolePrefixes || {};
    return {
      claudeToCodex: typeof prefixes.claudeToCodex === "string" ? prefixes.claudeToCodex : "",
      codexToClaude: typeof prefixes.codexToClaude === "string" ? prefixes.codexToClaude : ""
    };
  }

  function renderStatusPill(kind, label, value, title) {
    return `<span class="status-pill ${escapeHtml(kind)}" title="${escapeHtml(title || value)}">
      <span class="status-dot"></span>
      <span class="status-label">${escapeHtml(label)}</span>
      <span class="status-value">${escapeHtml(value)}</span>
    </span>`;
  }

  function syncSettingsFields() {
    const autoForward = snapshot.autoForward || {};
    const keywords = getAutoForwardKeywords();
    if (elements.autoForwardToggle instanceof HTMLInputElement) {
      elements.autoForwardToggle.checked = autoForward.enabled !== false;
    }

    if (!keywordDraftTouched) {
      if (elements.codexKeywords instanceof HTMLTextAreaElement) {
        elements.codexKeywords.value = keywordsToText(keywords.codex);
      }
      if (elements.claudeKeywords instanceof HTMLTextAreaElement) {
        elements.claudeKeywords.value = keywordsToText(keywords.claude);
      }
    }

    if (!rolePrefixDraftTouched) {
      const prefixes = getDirectionalRolePrefixes();
      if (elements.claudeToCodexPrefix instanceof HTMLTextAreaElement) {
        elements.claudeToCodexPrefix.value = prefixes.claudeToCodex;
      }
      if (elements.codexToClaudePrefix instanceof HTMLTextAreaElement) {
        elements.codexToClaudePrefix.value = prefixes.codexToClaude;
      }
    }
  }

  function render() {
    const monitor = snapshot.monitor || {};
    const bridge = snapshot.bridge || {};
    const autoForward = snapshot.autoForward || {};
    const bridgeDetail = bridge.error || bridge.message || "等待操作";
    const bridgeState = bridge.busy ? "发送中" : bridge.error ? "失败" : bridge.message ? "已完成" : "待命";
    const autoForwardState = autoForward.enabled === false
      ? "已关闭"
      : autoForward.status === "waiting"
        ? "等待"
        : autoForward.status === "sending"
          ? "发送中"
          : autoForward.status === "failed"
            ? "失败"
            : autoForward.status === "sent"
              ? "已完成"
              : "待命";
    const autoForwardDetail = autoForward.error || autoForward.message || autoForward.keyword || "等待关键词";
    const workspaceCwd = snapshot.workspaceCwd || "";
    const projectName = workspaceCwd ? workspaceCwd.split(/[/\\]/).pop() : "未知项目";
    const codexPreviewEntries = getRecentEntries(monitor.codex, PREVIEW_MESSAGE_COUNT);
    const claudePreviewEntries = getRecentEntries(monitor.claude, PREVIEW_MESSAGE_COUNT);
    const mergedEntries = getCombinedEntries(monitor);

    elements.statusBar.innerHTML = [
      renderStatusPill("project", "项目", projectName, workspaceCwd),
      renderStatusPill(monitor.enabled ? "ok" : "off", "监控", monitor.enabled ? "运行中" : "已关闭", ""),
      renderStatusPill(bridge.busy ? "busy" : bridge.error ? "bad" : "ok", "桥接", bridgeState, bridgeDetail),
      renderStatusPill(
        autoForward.enabled === false ? "off" : autoForward.status === "failed" ? "bad" : autoForward.status === "waiting" || autoForward.status === "sending" ? "busy" : "ok",
        "自动转发",
        autoForwardState,
        autoForwardDetail
      )
    ].join("");
    elements.statusDetail.innerHTML = escapeHtml(getVisibleStatusDetail(bridge, autoForward));

    elements.codexSession.innerHTML = renderSessionCard(monitor.codex, monitor.codexError, "Codex");
    elements.claudeSession.innerHTML = renderSessionCard(monitor.claude, monitor.claudeError, "Claude");
    elements.codexPreview.innerHTML = renderPreview(codexPreviewEntries);
    elements.claudePreview.innerHTML = renderPreview(claudePreviewEntries);
    elements.mergedTimeline.innerHTML = renderMergedTimeline(mergedEntries);
    syncSettingsFields();
  }

  function getVisibleStatusDetail(bridge, autoForward) {
    if (bridge.error) {
      return `桥接失败：${bridge.error}`;
    }
    if (bridge.busy && bridge.message) {
      return bridge.message;
    }
    if (autoForward.error) {
      return `自动转发失败：${autoForward.error}`;
    }
    if (autoForward.message) {
      return `自动转发：${autoForward.message}`;
    }
    return "状态：等待关键词或手动转发。";
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

  elements.logsButton.addEventListener("click", () => {
    vscode.postMessage({ type: "show-logs" });
  });

  elements.settingsButton.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    elements.settingsPanel.hidden = !settingsOpen;
    elements.settingsButton.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
    if (settingsOpen) {
      syncSettingsFields();
    }
  });

  elements.autoForwardToggle.addEventListener("change", () => {
    if (!(elements.autoForwardToggle instanceof HTMLInputElement)) {
      return;
    }
    vscode.postMessage({
      type: "toggle-auto-forward",
      autoForwardEnabled: elements.autoForwardToggle.checked
    });
  });

  elements.saveKeywordsButton.addEventListener("click", () => {
    const codexKeywords = elements.codexKeywords instanceof HTMLTextAreaElement
      ? textToKeywords(elements.codexKeywords.value)
      : DEFAULT_AUTO_FORWARD_KEYWORDS.codex;
    const claudeKeywords = elements.claudeKeywords instanceof HTMLTextAreaElement
      ? textToKeywords(elements.claudeKeywords.value)
      : DEFAULT_AUTO_FORWARD_KEYWORDS.claude;

    keywordDraftTouched = false;
    vscode.postMessage({
      type: "save-auto-forward-keywords",
      autoForwardKeywords: {
        codex: codexKeywords,
        claude: claudeKeywords
      }
    });
  });

  elements.resetKeywordsButton.addEventListener("click", () => {
    keywordDraftTouched = false;
    if (elements.codexKeywords instanceof HTMLTextAreaElement) {
      elements.codexKeywords.value = keywordsToText(DEFAULT_AUTO_FORWARD_KEYWORDS.codex);
    }
    if (elements.claudeKeywords instanceof HTMLTextAreaElement) {
      elements.claudeKeywords.value = keywordsToText(DEFAULT_AUTO_FORWARD_KEYWORDS.claude);
    }
    vscode.postMessage({
      type: "save-auto-forward-keywords",
      autoForwardKeywords: DEFAULT_AUTO_FORWARD_KEYWORDS
    });
  });

  elements.saveRolePrefixesButton.addEventListener("click", () => {
    const claudeToCodex = elements.claudeToCodexPrefix instanceof HTMLTextAreaElement
      ? elements.claudeToCodexPrefix.value
      : "";
    const codexToClaude = elements.codexToClaudePrefix instanceof HTMLTextAreaElement
      ? elements.codexToClaudePrefix.value
      : "";

    rolePrefixDraftTouched = false;
    vscode.postMessage({
      type: "save-directional-role-prefixes",
      directionalRolePrefixes: {
        claudeToCodex,
        codexToClaude
      }
    });
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
      if (target.classList.contains("role-prefix-input")) {
        rolePrefixDraftTouched = true;
      } else if (target.classList.contains("keyword-input")) {
        keywordDraftTouched = true;
      }
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
