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
    red:
      "身份：你是ClaudeCode，本项目专职产品经理，统筹多智能体开发项目，不编写代码，只拆解需求、输出开发指令、验收Codex开发成果、下发整改要求。\n协作关系：Codex为首席开发主管，带队多智能体团队编码落地，严格按你的指令开发。",
    blue:
      "身份锁定：你是Codex，首席开发负责人，统领多智能体开发小组，负责全部代码实现。\n上级对接：ClaudeCode为本项目产品经理，只下发开发指令、验收成果、提出修改意见，你严格按照ClaudeCode的指令开发。"
  };
  const elements = {
    logsButton: document.getElementById("logsButton"),
    refreshButton: document.getElementById("refreshButton"),
    settingsButton: document.getElementById("settingsButton"),
    settingsPanel: document.getElementById("settingsPanel"),
    statusBar: document.getElementById("statusBar"),
    statusDetail: document.getElementById("statusDetail"),
    redAgent: document.getElementById("redAgent"),
    blueAgent: document.getElementById("blueAgent"),
    pairCheckRow: document.getElementById("pairCheckRow"),
    zcodeDataDir: document.getElementById("zcodeDataDir"),
    saveZcodeButton: document.getElementById("saveZcodeButton"),
    autoForwardToggle: document.getElementById("autoForwardToggle"),
    codexKeywords: document.getElementById("codexKeywords"),
    claudeKeywords: document.getElementById("claudeKeywords"),
    saveKeywordsButton: document.getElementById("saveKeywordsButton"),
    resetKeywordsButton: document.getElementById("resetKeywordsButton"),
    redPrefix: document.getElementById("redPrefix"),
    bluePrefix: document.getElementById("bluePrefix"),
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
    pair: { red: "claude", blue: "codex" },
    pairCheck: {},
    pairStatus: {},
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
      enabled: false,
      status: "idle",
      keywords: DEFAULT_AUTO_FORWARD_KEYWORDS
    },
    directionalRolePrefixes: DEFAULT_DIRECTIONAL_ROLE_PREFIXES,
    zcodeDataDir: ""
  };
  let lastRenderSignature = "";
  let queuedSnapshot = null;
  const bridgeNoteDrafts = new Map();
  let deferredRenderTimer = null;
  let settingsOpen = false;
  let keywordDraftTouched = false;
  let rolePrefixDraftTouched = false;
  let zcodeDirDraftTouched = false;

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
      pair: nextSnapshot.pair,
      pairCheck: nextSnapshot.pairCheck,
      pairStatus: nextSnapshot.pairStatus,
      zcodeDataDir: nextSnapshot.zcodeDataDir,
      autoDebate: nextSnapshot.autoDebate,
      autoForward: nextSnapshot.autoForward,
      directionalRolePrefixes: nextSnapshot.directionalRolePrefixes,
      bridge: stableBridge,
      monitor: {
        enabled: monitor.enabled,
        codexError: monitor.codexError,
        claudeError: monitor.claudeError,
        zcodeError: monitor.zcodeError,
        codex: monitor.codex || null,
        claude: monitor.claude || null,
        zcode: monitor.zcode || null
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
    // 根据 pair 找出 session.agent 的对端作为转发目标 label。
    const pair = getPair();
    const otherAgentInPair = session.agent === pair.red ? pair.blue : (session.agent === pair.blue ? pair.red : "");
    const targetLabel = otherAgentInPair ? agentLabel(otherAgentInPair) : "另一端";
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

  // 根据 session.agent 在 pair 里的位置算角色 slot：红方→red，蓝方→blue，user→user。
  function slotForRole(role, sessionAgent) {
    if (role === "user") {
      return "user";
    }
    const pair = getPair();
    if (sessionAgent === pair.red) {
      return "red";
    }
    if (sessionAgent === pair.blue) {
      return "blue";
    }
    // agent 不在 pair 内（如遗留消息），回退到 red
    return "red";
  }

  function renderMessageCard(entry, options) {
    const message = entry.message;
    const session = entry.session;
    const meta = message.meta || {};
    const isProcess = meta.zcodeProcess === true || meta.zcodeProcess === "true";
    const slot = slotForRole(message.role, session.agent);
    const badgeText = message.role === "user" ? "你" : agentLabel(session.agent);
    const origin = options.showOrigin
      ? `<span class="origin-chip slot-${escapeHtml(slot)}">${escapeHtml(badgeText)}</span>`
      : "";
    const compactClass = options.compact ? " compact" : "";

    // 过程卡：tool-calls 中间步骤合并，默认折叠，点击展开
    if (isProcess) {
      const stepCount = meta.zcodeStepCount || "?";
      const summary = `运行了 ${stepCount} 个中间步骤`;
      const body = message.text
        ? `<pre class="message-text process-body">${escapeHtml(message.text)}</pre>`
        : `<div class="message-text process-body">(无可见文本)</div>`;
      return `<article class="message slot-${escapeHtml(slot)} process-card${compactClass}">
        <details data-process-id="${escapeHtml(message.id)}">
          <summary class="process-summary">${escapeHtml(summary)}</summary>
          ${body}
        </details>
      </article>`;
    }

    const textBlock = message.text
      ? `<pre class="message-text">${escapeHtml(message.text)}</pre>`
      : "";
    const actions = options.includeActions ? renderBridgeActions(session, message, entry.messageIndex) : "";

    return `<article class="message slot-${escapeHtml(slot)}${compactClass}">
      <div class="message-header">
        <div class="header-left">
          <span class="badge">${escapeHtml(badgeText)}</span>
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
    const sessions = [monitor.codex, monitor.claude, monitor.zcode].filter(Boolean);
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
    // 兼容旧格式 claudeToCodex/codexToClaude → red/blue
    const red = typeof prefixes.red === "string"
      ? prefixes.red
      : (typeof prefixes.codexToClaude === "string" ? prefixes.codexToClaude : "");
    const blue = typeof prefixes.blue === "string"
      ? prefixes.blue
      : (typeof prefixes.claudeToCodex === "string" ? prefixes.claudeToCodex : "");
    return { red, blue };
  }

  function getPair() {
    const pair = snapshot.pair || {};
    return {
      red: pair.red || "",
      blue: pair.blue || ""
    };
  }

  function agentLabel(agent) {
    if (agent === "codex") {
      return "Codex";
    }
    if (agent === "claude") {
      return "Claude";
    }
    if (agent === "zcode") {
      return "ZCode";
    }
    return "未选择";
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

    // 桥接对象（pair）+ 三色状态灯
    const pair = getPair();
    if (elements.redAgent instanceof HTMLSelectElement) {
      elements.redAgent.value = pair.red;
    }
    if (elements.blueAgent instanceof HTMLSelectElement) {
      elements.blueAgent.value = pair.blue;
    }
    // 指示灯已移到顶部状态栏 ZCode pill，折叠区不再重复显示。
    if (elements.pairCheckRow) {
      elements.pairCheckRow.innerHTML = "";
    }

    // ZCode 数据目录（编辑中不覆盖，保存后才回填）
    if (!zcodeDirDraftTouched) {
      if (elements.zcodeDataDir instanceof HTMLInputElement) {
        elements.zcodeDataDir.value = snapshot.zcodeDataDir || "";
      }
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
      if (elements.redPrefix instanceof HTMLTextAreaElement) {
        elements.redPrefix.value = prefixes.red;
      }
      if (elements.bluePrefix instanceof HTMLTextAreaElement) {
        elements.bluePrefix.value = prefixes.blue;
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

    const pair = getPair();
    const pairCheck = snapshot.pairCheck || {};
    const pairStatus = snapshot.pairStatus || {};
    const pairValue = `${agentLabel(pair.red)} ↔ ${agentLabel(pair.blue)}`;
    // 桥接对状态灯：取两端最差值（red > yellow > green > none）
    const order = { red: 0, yellow: 1, green: 2, none: 3 };
    const worst = [pairStatus.red, pairStatus.blue]
      .filter(Boolean)
      .sort((a, b) => (order[a] ?? 3) - (order[b] ?? 3))[0];
    const pairPillKind = worst === "red" ? "bad" : worst === "yellow" ? "busy" : worst === "green" ? "ok" : "off";
    const pairDetail = `${pairCheck.red || "—"} | ${pairCheck.blue || "—"}`;
    const pills = [
      renderStatusPill("project", "项目", projectName, workspaceCwd),
      renderStatusPill(pairPillKind, "桥接对", pairValue, pairDetail),
      renderStatusPill(monitor.enabled ? "ok" : "off", "监控", monitor.enabled ? "运行中" : "已关闭", ""),
      renderStatusPill(bridge.busy ? "busy" : bridge.error ? "bad" : "ok", "桥接", bridgeState, bridgeDetail),
      renderStatusPill(
        autoForward.enabled === false ? "off" : autoForward.status === "failed" ? "bad" : autoForward.status === "waiting" || autoForward.status === "sending" ? "busy" : "ok",
        "自动转发",
        autoForwardState,
        autoForwardDetail
      )
    ];
    // ZCode 状态灯（仅当 pair 含 zcode 时显示）：红→未检测/黄→待点击或重启中/绿→桥接成功
    const zcodeSlot = pair.red === "zcode" ? "red" : (pair.blue === "zcode" ? "blue" : null);
    if (zcodeSlot) {
      const zs = pairStatus[zcodeSlot];
      const zkind = zs === "red" ? "bad" : zs === "yellow" ? "busy" : zs === "green" ? "ok" : "off";
      const zval = zs === "red" ? "未检测" : zs === "yellow" ? "待重启" : zs === "green" ? "桥接成功" : "未选择";
      const ztitle = pairCheck[zcodeSlot] || zval;
      // 非绿（红/黄）都可点击触发重检（重启流程）
      const clickable = zs === "red" || zs === "yellow";
      const pillHtml = renderStatusPill(zkind, "ZCode", zval, ztitle);
      pills.push(clickable
        ? pillHtml.replace("<span ", `<span data-recheck="zcode" style="cursor:pointer" `)
        : pillHtml);
    }
    elements.statusBar.innerHTML = pills.join("");
    elements.statusDetail.innerHTML = escapeHtml(getVisibleStatusDetail(bridge, autoForward, snapshot.pairCheck, snapshot.pairStatus));

    elements.codexSession.innerHTML = renderSessionCard(monitor.codex, monitor.codexError, "Codex");
    elements.claudeSession.innerHTML = renderSessionCard(monitor.claude, monitor.claudeError, "Claude");
    elements.codexPreview.innerHTML = renderPreview(codexPreviewEntries);
    elements.claudePreview.innerHTML = renderPreview(claudePreviewEntries);

    // 渲染前记录已展开的过程卡 id，渲染后恢复（避免轮询重渲染折叠用户的展开）
    const expandedProcessIds = new Set(
      Array.from(elements.mergedTimeline.querySelectorAll("details[data-process-id][open]"))
        .map((d) => d.getAttribute("data-process-id"))
    );
    elements.mergedTimeline.innerHTML = renderMergedTimeline(mergedEntries);
    if (expandedProcessIds.size > 0) {
      Array.from(elements.mergedTimeline.querySelectorAll("details[data-process-id]")).forEach((d) => {
        if (expandedProcessIds.has(d.getAttribute("data-process-id"))) {
          d.setAttribute("open", "");
        }
      });
    }

    syncSettingsFields();
  }

  function getVisibleStatusDetail(bridge, autoForward, pairCheck, pairStatus) {
    // 桥接对状态优先：红灯显示引导，黄灯显示进度。
    const dot = (s) => (s === "green" ? "🟢" : s === "yellow" ? "🟡" : s === "red" ? "🔴" : "⚪");
    const slots = ["red", "blue"];
    for (const slot of slots) {
      const st = pairStatus ? pairStatus[slot] : undefined;
      if (st === "red") {
        return `${dot(st)} ${slot === "red" ? "红方" : "蓝方"}：未就绪。请打开 ZCode 桌面应用后，点击红灯重新检测`;
      }
      if (st === "yellow") {
        const msg = pairCheck && pairCheck[slot] ? pairCheck[slot] : "重启中";
        return `${dot(st)} ${slot === "red" ? "红方" : "蓝方"}：${msg}`;
      }
    }
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
    const red = elements.redPrefix instanceof HTMLTextAreaElement
      ? elements.redPrefix.value
      : "";
    const blue = elements.bluePrefix instanceof HTMLTextAreaElement
      ? elements.bluePrefix.value
      : "";

    rolePrefixDraftTouched = false;
    vscode.postMessage({
      type: "save-directional-role-prefixes",
      directionalRolePrefixes: { red, blue }
    });
  });

  // 桥接对象（pair）select change handler
  const postPairChange = () => {
    const red = elements.redAgent instanceof HTMLSelectElement ? elements.redAgent.value : "";
    const blue = elements.blueAgent instanceof HTMLSelectElement ? elements.blueAgent.value : "";
    vscode.postMessage({
      type: "set-bridge-pair",
      pair: { red: red || null, blue: blue || null }
    });
  };
  if (elements.redAgent) {
    elements.redAgent.addEventListener("change", postPairChange);
  }
  if (elements.blueAgent) {
    elements.blueAgent.addEventListener("change", postPairChange);
  }

  elements.saveZcodeButton.addEventListener("click", () => {
    const dataDir = elements.zcodeDataDir instanceof HTMLInputElement ? elements.zcodeDataDir.value : "";
    zcodeDirDraftTouched = false;
    vscode.postMessage({
      type: "save-zcode-config",
      zcodeDataDir: dataDir
    });
  });

  document.body.addEventListener("click", (event) => {
    // 红灯点击触发 ZCode 重新检测
    const recheckTarget = event.target instanceof Element ? event.target.closest("[data-recheck='zcode']") : null;
    if (recheckTarget) {
      vscode.postMessage({ type: "recheck-zcode" });
      return;
    }

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

    // ZCode 数据目录输入框（HTMLInputElement）
    if (target instanceof HTMLInputElement && target.id === "zcodeDataDir") {
      zcodeDirDraftTouched = true;
      return;
    }

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
