import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as os from "os";
import * as path from "path";
import { ChatMessage, MonitoredSession, OfficialMonitorSnapshot, PreferredMonitorSession } from "../types";
import { normalizePath } from "../utils";

interface CodexSessionMeta {
  id: string;
  cwd?: string;
  originator?: string;
  source?: unknown;
}

interface ClaudeSessionIndex {
  sessionId: string;
  cwd?: string;
  entrypoint?: string;
}

interface CodexTurnState {
  hasTurnEvents: boolean;
  active: boolean;
  messageIndexes: number[];
}

interface CodexRawMessage extends Omit<ChatMessage, "id"> {
  meta: Record<string, string | number | boolean>;
}

export type ZCodeSessionReader = (workspaceCwd: string) => Promise<MonitoredSession | undefined>;

export class OfficialTranscriptMonitor {
  public constructor(
    private readonly workspaceCwd: string,
    private readonly zcodeReader?: ZCodeSessionReader
  ) {}

  public async readSnapshot(preferredSession?: PreferredMonitorSession): Promise<OfficialMonitorSnapshot> {
    const tasks: Array<Promise<MonitoredSession | undefined>> = [
      this.readCodexSession(this.workspaceCwd, preferredSession?.agent === "codex" ? preferredSession : undefined),
      this.readClaudeSession(this.workspaceCwd),
      this.readZCodeSession(this.workspaceCwd)
    ];

    const [codexResult, claudeResult, zcodeResult] = await Promise.allSettled(tasks);

    return {
      enabled: true,
      lastUpdated: Date.now(),
      codex: codexResult.status === "fulfilled" ? codexResult.value : undefined,
      claude: claudeResult.status === "fulfilled" ? claudeResult.value : undefined,
      zcode: zcodeResult.status === "fulfilled" ? zcodeResult.value : undefined,
      codexError: codexResult.status === "rejected" ? this.toErrorMessage(codexResult.reason) : undefined,
      claudeError: claudeResult.status === "rejected" ? this.toErrorMessage(claudeResult.reason) : undefined,
      zcodeError: zcodeResult.status === "rejected" ? this.toErrorMessage(zcodeResult.reason) : undefined
    };
  }

  private async readZCodeSession(workspaceCwd: string): Promise<MonitoredSession | undefined> {
    if (!this.zcodeReader) {
      return undefined;
    }
    return this.zcodeReader(workspaceCwd);
  }

  public async parseCodexSessionForTest(
    filePath: string,
    updatedAt: number,
    workspaceCwd = this.workspaceCwd
  ): Promise<MonitoredSession | undefined> {
    return this.parseCodexSession(filePath, updatedAt, workspaceCwd);
  }

  private async readCodexSession(
    workspaceCwd: string,
    preferredSession?: PreferredMonitorSession
  ): Promise<MonitoredSession | undefined> {
    const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
    const files = await this.findFiles(sessionsRoot, (filePath) => filePath.endsWith(".jsonl"));
    const enriched: Array<{ filePath: string; stat: Awaited<ReturnType<typeof fs.stat>> }> = [];

    if (preferredSession?.sourcePath) {
      try {
        const stat = await fs.stat(preferredSession.sourcePath);
        const session = await this.parseCodexSession(preferredSession.sourcePath, Number(stat.mtimeMs), workspaceCwd);
        if (session?.sessionId === preferredSession.sessionId) {
          return session;
        }
      } catch {
        // Fall through to the normal latest-session scan.
      }
    }

    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      enriched.push({ filePath, stat });
    }

    enriched.sort((left, right) => Number(right.stat.mtimeMs) - Number(left.stat.mtimeMs));

    for (const entry of enriched) {
      const session = await this.parseCodexSession(entry.filePath, Number(entry.stat.mtimeMs), workspaceCwd);
      if (session) {
        return session;
      }
    }

    return undefined;
  }

  private async parseCodexSession(
    filePath: string,
    updatedAt: number,
    workspaceCwd: string
  ): Promise<MonitoredSession | undefined> {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    let meta: CodexSessionMeta | undefined;
    const rawMessages: CodexRawMessage[] = [];
    const turnState: CodexTurnState = {
      hasTurnEvents: false,
      active: false,
      messageIndexes: []
    };

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === "session_meta") {
        meta = parsed.payload as CodexSessionMeta;
        continue;
      }

      if (parsed.type === "event_msg") {
        this.applyCodexEvent(parsed.payload, rawMessages, turnState);
        continue;
      }

      if (parsed.type !== "response_item") {
        continue;
      }

      const payload = parsed.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "message") {
        continue;
      }

      const role = payload.role === "assistant" ? "codex" : payload.role === "user" ? "user" : undefined;
      if (!role) {
        continue;
      }

      const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Date.now();
      const text = this.extractCodexMessageText(payload.content);
      if (!text.trim()) {
        continue;
      }
      if (role === "user" && this.isCodexHarnessUserText(text)) {
        continue;
      }

      rawMessages.push({
        role,
        text,
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
        meta: {
          monitorAgent: "codex",
          official: true,
          ...(turnState.hasTurnEvents && role === "codex" ? { codexHasTurnEvents: true } : {}),
          ...(typeof payload.phase === "string" ? { phase: payload.phase } : {})
        }
      });
      if (turnState.active && role === "codex") {
        turnState.messageIndexes.push(rawMessages.length - 1);
      }
    }

    this.applyCodexLegacyCompletion(rawMessages, updatedAt);

    if (
      !meta ||
      meta.originator !== "codex_vscode" ||
      normalizePath(meta.cwd) !== normalizePath(workspaceCwd) ||
      this.isCodexSubagent(meta.source) ||
      rawMessages.length === 0 ||
      !rawMessages.some((message) => message.role === "codex")
    ) {
      return undefined;
    }

    const messages = rawMessages.map((message, index) => ({
      ...message,
      id: this.createMonitorMessageId("codex", meta.id, index)
    }));

    return {
      agent: "codex",
      sessionId: meta.id,
      title: this.buildTitle("Codex", messages),
      cwd: meta.cwd,
      sourcePath: filePath,
      updatedAt,
      messageCount: messages.length,
      messages
    };
  }

  private applyCodexEvent(payload: unknown, rawMessages: CodexRawMessage[], turnState: CodexTurnState): void {
    if (!this.isObject(payload)) {
      return;
    }

    if (payload.type === "task_started") {
      turnState.hasTurnEvents = true;
      turnState.active = true;
      turnState.messageIndexes = [];
      return;
    }

    if (payload.type !== "task_complete") {
      return;
    }

    turnState.hasTurnEvents = true;
    const lastAgentMessage = typeof payload.last_agent_message === "string" ? payload.last_agent_message.trim() : "";
    const completedIndex = lastAgentMessage
      ? this.findMatchingCodexTurnMessage(rawMessages, turnState.messageIndexes, lastAgentMessage)
      : this.findLatestCodexFinalAnswer(rawMessages, turnState.messageIndexes);
    if (typeof completedIndex === "number") {
      rawMessages[completedIndex].meta.codexComplete = true;
    }

    turnState.active = false;
    turnState.messageIndexes = [];
  }

  private findMatchingCodexTurnMessage(
    rawMessages: CodexRawMessage[],
    messageIndexes: number[],
    lastAgentMessage: string
  ): number | undefined {
    for (let index = messageIndexes.length - 1; index >= 0; index -= 1) {
      const messageIndex = messageIndexes[index];
      const message = rawMessages[messageIndex];
      if (message?.role === "codex" && message.text.trim() === lastAgentMessage) {
        return messageIndex;
      }
    }

    return this.findLatestCodexFinalAnswer(rawMessages, messageIndexes);
  }

  private findLatestCodexFinalAnswer(rawMessages: CodexRawMessage[], messageIndexes: number[]): number | undefined {
    for (let index = messageIndexes.length - 1; index >= 0; index -= 1) {
      const messageIndex = messageIndexes[index];
      const message = rawMessages[messageIndex];
      if (message?.role === "codex" && message.meta.phase === "final_answer") {
        return messageIndex;
      }
    }

    return undefined;
  }

  private applyCodexLegacyCompletion(rawMessages: CodexRawMessage[], updatedAt: number): void {
    const hasTurnEvents = rawMessages.some((message) => message.meta.codexHasTurnEvents === true);
    if (hasTurnEvents || Date.now() - updatedAt < 120_000) {
      return;
    }

    for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
      const message = rawMessages[index];
      if (message.role === "codex" && message.text.trim()) {
        message.meta.codexLegacyStable = true;
        return;
      }
    }
  }

  private async readClaudeSession(workspaceCwd: string): Promise<MonitoredSession | undefined> {
    const sessionsRoot = path.join(os.homedir(), ".claude", "sessions");
    const files = await this.findFiles(sessionsRoot, (filePath) => filePath.endsWith(".json"));
    const enriched: Array<{ filePath: string; stat: Awaited<ReturnType<typeof fs.stat>> }> = [];

    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      enriched.push({ filePath, stat });
    }

    enriched.sort((left, right) => Number(right.stat.mtimeMs) - Number(left.stat.mtimeMs));

    for (const entry of enriched) {
      const raw = await fs.readFile(entry.filePath, "utf8");
      let index: ClaudeSessionIndex;
      try {
        index = JSON.parse(raw) as ClaudeSessionIndex;
      } catch {
        continue;
      }

      if (!index.sessionId) {
        continue;
      }

      if (normalizePath(index.cwd) !== normalizePath(workspaceCwd)) {
        continue;
      }

      const transcriptPath = await this.findClaudeTranscript(index.sessionId);
      if (!transcriptPath) {
        continue;
      }

      const session = await this.parseClaudeSession(transcriptPath, index, Number(entry.stat.mtimeMs));
      if (session) {
        return session;
      }
    }

    return undefined;
  }

  private async parseClaudeSession(
    filePath: string,
    index: ClaudeSessionIndex,
    updatedAt: number
  ): Promise<MonitoredSession | undefined> {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const rawMessages: Omit<ChatMessage, "id">[] = [];

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === "user") {
        const message = parsed.message as Record<string, unknown> | undefined;
        const text = this.extractClaudeUserText(message?.content);
        const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Date.now();
        if (text.trim() && !this.isClaudeHarnessUserText(text)) {
          rawMessages.push({
            role: "user",
            text,
            createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
            meta: {
              monitorAgent: "claude",
              official: true
            }
          });
        }
        continue;
      }

      if (parsed.type === "assistant") {
        const message = parsed.message as Record<string, unknown> | undefined;
        const contentBlocks = Array.isArray(message?.content) ? message?.content : [];
        const text = contentBlocks
          .filter((entry) => this.isObject(entry) && entry.type === "text" && typeof entry.text === "string")
          .map((entry) => String((entry as Record<string, unknown>).text))
          .join("\n\n");
        const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Date.now();

        if (text.trim()) {
          const stopReason = typeof message?.stop_reason === "string" ? message.stop_reason : undefined;
          rawMessages.push({
            role: "claude",
            text,
            createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
            meta: {
              monitorAgent: "claude",
              official: true,
              ...(stopReason ? { stopReason } : {})
            }
          });
        }
      }
    }

    if (rawMessages.length === 0 || !rawMessages.some((message) => message.role === "claude")) {
      return undefined;
    }

    const messages = rawMessages.map((message, messageIndex) => ({
      ...message,
      id: this.createMonitorMessageId("claude", index.sessionId, messageIndex)
    }));

    return {
      agent: "claude",
      sessionId: index.sessionId,
      title: this.buildTitle("Claude", messages),
      cwd: index.cwd,
      sourcePath: filePath,
      updatedAt,
      messageCount: messages.length,
      messages
    };
  }

  private async findClaudeTranscript(sessionId: string): Promise<string | undefined> {
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const files = await this.findFiles(projectsRoot, (filePath) => path.basename(filePath) === `${sessionId}.jsonl`);
    return files[0];
  }

  private extractCodexMessageText(content: unknown): string {
    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((entry) => {
        if (!this.isObject(entry)) {
          return "";
        }
        return typeof entry.text === "string" ? entry.text : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private extractClaudeUserText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((entry) => {
        if (!this.isObject(entry)) {
          return "";
        }

        const entryType = typeof entry.type === "string" ? entry.type : "";
        if (entryType === "tool_result" || entryType === "tool_use") {
          return "";
        }

        if ((entryType === "" || entryType === "text") && typeof entry.text === "string") {
          return entry.text;
        }

        if (
          (entryType === "" || entryType === "input_text" || entryType === "text") &&
          typeof entry.content === "string"
        ) {
          return entry.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private buildTitle(agentLabel: string, messages: ChatMessage[]): string {
    const titledUserMessages = messages.filter((message) => message.role === "user" && message.text.trim());
    const chosenUser = titledUserMessages.at(-1);
    if (!chosenUser) {
      return `${agentLabel} Session`;
    }

    const compact = chosenUser.text.replace(/\s+/g, " ").trim();
    return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
  }

  private createMonitorMessageId(agent: "codex" | "claude", sessionId: string, index: number): string {
    return `monitor:${agent}:${sessionId}:${index}`;
  }

  private isClaudeHarnessUserText(text: string): boolean {
    const compact = text.replace(/\s+/g, " ").trim();
    return (
      compact === "[Request interrupted by user for tool use]" ||
      compact === "[Request interrupted by user]"
    );
  }

  private isCodexHarnessUserText(text: string): boolean {
    const compact = text.replace(/\s+/g, " ").trim();
    return (
      compact.startsWith("# AGENTS.md instructions") ||
      compact.startsWith("<permissions instructions>") ||
      compact.startsWith("<skills_instructions>") ||
      compact.startsWith("<collaboration_mode>") ||
      compact.includes("<environment_context>") ||
      compact.includes("<INSTRUCTIONS>") ||
      compact.includes("Filesystem sandboxing defines which files can be read or written.") ||
      compact.includes("## Skills") ||
      compact.includes("Available skills:")
    );
  }

  private isCodexSubagent(source: unknown): boolean {
    if (!this.isObject(source)) {
      return false;
    }
    return this.isObject(source.subagent);
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private async findFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
    const results: string[] = [];
    const queue = [root];

    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryName = typeof entry.name === "string" ? entry.name : String(entry.name);
        const filePath = path.join(current, entryName);
        if (entry.isDirectory()) {
          queue.push(filePath);
          continue;
        }

        if (predicate(filePath)) {
          results.push(filePath);
        }
      }
    }

    return results;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  }
}
