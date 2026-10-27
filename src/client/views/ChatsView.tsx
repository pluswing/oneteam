import { formatDisplayValue } from "../formatters";
import { Bot, Check, ChevronDown, LoaderCircle, MessageCircle, Pencil, Plus, Send, Square, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ChatDetail, ChatMessageDto, ChatModelsResponse, ChatSessionDto } from "../../shared/chat";
import type { ProjectDto } from "../../shared/types";
import { api } from "../api";
import { AsyncState } from "../components/AsyncState";
import { MarkdownContent } from "../components/MarkdownContent";
import { t } from "../i18n";

function operationLabel(message: ChatMessageDto): string {
  const path = String(message.metadata?.path ?? "");
  const method = String(message.metadata?.method ?? "GET");
  if (method === "GET") return t("chat.operationRead");
  if (/\/merge$/.test(path)) return t("chat.operationMerge");
  if (/\/model(?:-settings)?$/.test(path)) return t("chat.operationModel");
  if (/\/(?:restart|retry|resume)$/.test(path)) return t("chat.operationRestart");
  if (/\/issues$/.test(path) && method === "POST") return t("chat.operationIssue");
  return t("chat.operationChange");
}

export function ChatsView({ project, chatId, onSelectChat }: { project: ProjectDto; chatId: string | null; onSelectChat: (id: string | null) => void }) {
  const [sessions, setSessions] = useState<ChatSessionDto[]>([]);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [models, setModels] = useState<ChatModelsResponse | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(chatId));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newEffort, setNewEffort] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const pendingRequest = useRef<{ chatId: string; text: string; id: string } | null>(null);
  const selected = useRef(chatId); selected.current = chatId;
  const draftKey = chatId ?? "new";
  const draft = drafts[draftKey] ?? "";
  const current = detail?.chat.id === chatId ? detail : null;
  const running = current?.chat.status === "running";
  const busy = sending || running;
  const selectedModel = current?.chat.model ?? (chatId ? "" : newModel);
  const selectedEffort = current?.chat.effort ?? (chatId ? "" : newEffort);
  const capabilities = models?.models.find((model) => model.model === (selectedModel || models.preferredModel));
  const setDraft = (value: string) => setDrafts((previous) => ({ ...previous, [draftKey]: value }));

  useEffect(() => {
    let disposed = false;
    void api.getChatModels(project.id).then((value) => { if (!disposed) { setModels(value); setModelError(null); } })
      .catch((error: unknown) => { if (!disposed) setModelError(error instanceof Error ? error.message : t("chat.modelsUnavailable")); });
    return () => { disposed = true; };
  }, [project.id]);

  useEffect(() => {
    let disposed = false;
    setDetail(null); setError(null); setEditingTitle(false); setLoading(Boolean(chatId)); followBottom.current = true;
    const refresh = async () => {
      const [list, conversation] = await Promise.all([api.listChats(project.id), chatId ? api.getChat(project.id, chatId) : Promise.resolve(null)]);
      if (disposed) return;
      setSessions(list); setDetail(conversation); setLoading(false);
    };
    void refresh().catch((error: unknown) => { if (!disposed) { setError(error instanceof Error ? error.message : t("chat.loadFailed")); setLoading(false); } });
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [project.id, chatId]);

  useEffect(() => {
    const area = scrollArea.current;
    if (area && followBottom.current) area.scrollTop = area.scrollHeight;
  }, [current?.messages]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setSending(true); setError(null); followBottom.current = true;
    const originalId = chatId;
    try {
      let id = chatId;
      if (!id) {
        const chat = await api.createChat(project.id); id = chat.id;
        if (newModel || newEffort) await api.updateChat(project.id, id, { model: newModel || null, effort: newEffort || null });
        setDrafts((previous) => ({ ...previous, [chat.id]: text }));
        setSessions((previous) => [chat, ...previous]); onSelectChat(id);
      }
      const previousRequest = pendingRequest.current;
      const requestId = previousRequest?.chatId === id && previousRequest.text === text ? previousRequest.id : crypto.randomUUID();
      pendingRequest.current = { chatId: id, text, id: requestId };
      const response = await api.sendChatMessage(project.id, id, text, requestId);
      pendingRequest.current = null;
      setDrafts((previous) => ({ ...previous, [originalId ?? "new"]: "", [id!]: "" }));
      if (selected.current === id || selected.current === originalId) setDetail(response);
      setSessions(await api.listChats(project.id));
    } catch (error) { setError(error instanceof Error ? error.message : t("chat.sendFailed")); }
    finally { setSending(false); textarea.current?.focus(); }
  }
  async function stop() {
    if (!chatId) return;
    setStopping(true); setError(null);
    try { const result = await api.stopChat(project.id, chatId); if (selected.current === chatId) setDetail(result); }
    catch (error) { setError(error instanceof Error ? error.message : t("chat.stopFailed")); }
    finally { setStopping(false); }
  }
  async function changeModel(model: string, effort: string) {
    if (!chatId) { setNewModel(model); setNewEffort(effort); return; }
    try {
      const updated = await api.updateChat(project.id, chatId, { model: model || null, effort: effort || null });
      setDetail((previous) => previous?.chat.id === updated.id ? { ...previous, chat: updated } : previous); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : t("chat.settingsFailed")); }
  }
  async function rename(event: FormEvent) {
    event.preventDefault(); if (!chatId || !title.trim()) return;
    try {
      const chat = await api.updateChat(project.id, chatId, { title: title.trim() });
      setDetail((previous) => previous ? { ...previous, chat } : previous); setSessions(await api.listChats(project.id)); setEditingTitle(false);
    } catch (error) { setError(error instanceof Error ? error.message : t("chat.settingsFailed")); }
  }
  async function remove() {
    if (!chatId || !window.confirm(t("chat.deleteConfirm"))) return;
    try { await api.deleteChat(project.id, chatId); setSessions(await api.listChats(project.id)); onSelectChat(null); }
    catch (error) { setError(error instanceof Error ? error.message : t("chat.deleteFailed")); }
  }

  return <div className="chat-workspace">
    <aside className="chat-sidebar" aria-label={t("chat.conversations")}>
      <div className="chat-sidebar-heading"><MessageCircle size={18} /><h1>{t("nav.chats")}</h1></div>
      <button className="primary-button chat-new" type="button" onClick={() => { onSelectChat(null); setDetail(null); textarea.current?.focus(); }}><Plus size={16} />{t("chat.newChat")}</button>
      <div className="chat-session-list">
        {sessions.map((session) => <button key={session.id} type="button" className={`chat-session${session.id === chatId ? " selected" : ""}`}
          aria-current={session.id === chatId ? "page" : undefined} onClick={() => onSelectChat(session.id)}>
          {session.status === "running" ? <LoaderCircle className="chat-spinner" size={15} /> : <MessageCircle size={15} />}
          <span><strong>{session.title}</strong><small>{new Intl.DateTimeFormat(project.locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(session.updatedAt))}</small></span>
        </button>)}
        {!sessions.length ? <p className="chat-sidebar-empty">{t("chat.noChats")}</p> : null}
      </div>
      <p className="chat-context-note">{t("chat.contextNote")}</p>
    </aside>
    <section className="chat-main" aria-label={t("chat.conversation")}>
      <header className="chat-heading">
        <div>{editingTitle ? <form className="chat-title-form" onSubmit={(event) => void rename(event)}>
          <input aria-label={t("chat.title")} autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          <button className="icon-button" type="submit" aria-label={t("actions.save")}><Check size={17} /></button>
          <button className="icon-button" type="button" aria-label={t("actions.cancel")} onClick={() => setEditingTitle(false)}><X size={17} /></button>
        </form> : <><h2>{current?.chat.title ?? t("chat.newChat")}</h2><p>{t("chat.subtitle")}</p></>}</div>
        {current ? <div className="chat-heading-actions">
          <button className="icon-button" type="button" disabled={busy} aria-label={t("chat.rename")} title={t("chat.rename")} onClick={() => { setTitle(current.chat.title); setEditingTitle(true); }}><Pencil size={16} /></button>
          <button className="icon-button" type="button" disabled={busy} aria-label={t("chat.delete")} title={t("chat.delete")} onClick={() => void remove()}><Trash2 size={16} /></button>
        </div> : null}
      </header>
      <div className="chat-messages" ref={scrollArea} onScroll={() => { const area = scrollArea.current; if (area) followBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 100; }}>
        {loading ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
        {!loading && !current?.messages.length ? <div className="chat-welcome">
          <div className="chat-welcome-icon"><Bot size={30} /></div><h2>{t("chat.welcome")}</h2><p>{t("chat.welcomeHint")}</p>
          <div className="chat-suggestions">{["status", "issue", "jobs", "models"].map((key) => <button key={key} type="button" onClick={() => { setDraft(t(`chat.suggestion_${key}`)); textarea.current?.focus(); }}>
            <strong>{t(`chat.suggestionTitle_${key}`)}</strong><span>{t(`chat.suggestion_${key}`)}</span>
          </button>)}</div>
        </div> : null}
        {current?.messages.map((message) => message.role === "tool" ? <details key={message.id} className={`chat-operation chat-operation-${message.status}`}>
          <summary><Wrench size={14} /><span>{operationLabel(message)}</span><small>{t(`chat.operation_${message.status}`)}</small><ChevronDown size={14} /></summary>
          <pre>{message.content}</pre>
        </details> : <article key={message.id} className={`chat-message chat-message-${message.role}`} aria-label={message.role === "user" ? t("chat.you") : "OneTeam"}>
          <div className="chat-message-author">{message.role === "assistant" ? <Bot size={16} /> : null}<strong>{message.role === "user" ? t("chat.you") : "OneTeam"}</strong>
            {message.role === "assistant" && typeof message.metadata?.model === "string" ? <small>{message.metadata.model}</small> : null}</div>
          {message.content ? <MarkdownContent content={message.content} /> : message.status === "running" ? <div className="chat-thinking" role="status"><LoaderCircle size={15} className="chat-spinner" />{t("chat.thinking")}</div> : null}
          {message.status === "failed" ? <p className="chat-message-error">{String(message.metadata?.error ?? t("chat.responseFailed"))}</p> : null}
          {message.status === "canceled" ? <p className="chat-message-note">{t("chat.canceled")}</p> : null}
        </article>)}
      </div>
      <div className="chat-compose-area">
        {error ? <AsyncState compact kind="error" message={error} /> : null}
        <form className="chat-composer" onSubmit={(event) => void send(event)}>
          <textarea ref={textarea} aria-label={t("chat.message")} placeholder={t("chat.placeholder")} value={draft} maxLength={32000} rows={3}
            onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} />
          <div className="chat-composer-toolbar"><div className="chat-model-controls">
            <label><span className="visually-hidden">{t("chat.model")}</span><select aria-label={t("chat.model")} disabled={busy || !models} value={selectedModel}
              onChange={(event) => void changeModel(event.target.value, "")}><option value="">{t("chat.autoModel")}</option>
              {selectedModel && !models?.models.some((model) => model.model === selectedModel) ? <option value={selectedModel}>{selectedModel}</option> : null}
              {models?.models.map((model) => <option key={model.model} value={model.model}>{model.displayName}</option>)}
            </select></label>
            <select aria-label={t("chat.effort")} disabled={busy || !models} value={selectedEffort} onChange={(event) => void changeModel(selectedModel, event.target.value)}>
              <option value="">{t("chat.autoEffort")}</option>{capabilities?.supportedReasoningEfforts.map((entry) => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{formatDisplayValue(entry.reasoningEffort)}</option>)}
            </select>
          </div>{running ? <button className="secondary-button" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{t("chat.stop")}</button>
            : <button className="primary-button" type="submit" disabled={!draft.trim() || sending || loading}><Send size={15} />{sending ? t("chat.sending") : t("chat.send")}</button>}</div>
        </form>
        <p className="chat-composer-hint">{modelError ? `${t("chat.modelsUnavailable")} ${modelError}` : t("chat.composerHint")}</p>
      </div>
    </section>
  </div>;
}
