import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { ChatMessageDto, ChatSessionDto } from "../../shared/chat";
import type { Database } from "./client";
import { chatMessages, chatSessions } from "./chat-schema";

const now = () => new Date().toISOString();
function messageDto(row: typeof chatMessages.$inferSelect): ChatMessageDto {
  const { metadataJson, ...message } = row;
  return { ...message, metadata: metadataJson ? JSON.parse(metadataJson) as Record<string, unknown> : null };
}
export function createChatRepositories(db: Database) {
  return {
    async list(projectId: string): Promise<ChatSessionDto[]> {
      return db.select().from(chatSessions).where(eq(chatSessions.projectId, projectId)).orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id));
    },
    async get(projectId: string, id: string): Promise<ChatSessionDto | null> {
      return (await db.select().from(chatSessions).where(and(eq(chatSessions.projectId, projectId), eq(chatSessions.id, id))).limit(1))[0] ?? null;
    },
    async create(projectId: string, title: string): Promise<ChatSessionDto> {
      return (await db.insert(chatSessions).values({ id: randomUUID(), projectId, title, status: "idle", createdAt: now(), updatedAt: now() }).returning())[0];
    },
    async update(projectId: string, id: string, patch: Partial<Pick<ChatSessionDto, "title" | "model" | "effort" | "threadId" | "status" | "error">>): Promise<ChatSessionDto | null> {
      return (await db.update(chatSessions).set({ ...patch, updatedAt: now() }).where(and(eq(chatSessions.projectId, projectId), eq(chatSessions.id, id))).returning())[0] ?? null;
    },
    async claim(projectId: string, id: string): Promise<boolean> {
      return (await db.update(chatSessions).set({ status: "running", error: null, updatedAt: now() })
        .where(and(eq(chatSessions.projectId, projectId), eq(chatSessions.id, id), eq(chatSessions.status, "idle"))).returning()).length === 1;
    },
    async remove(projectId: string, id: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(chatMessages).where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.chatId, id)));
        await tx.delete(chatSessions).where(and(eq(chatSessions.projectId, projectId), eq(chatSessions.id, id)));
      });
    },
    async messages(projectId: string, chatId: string): Promise<ChatMessageDto[]> {
      return (await db.select().from(chatMessages).where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.chatId, chatId))).orderBy(asc(chatMessages.id))).map(messageDto);
    },
    async append(projectId: string, chatId: string, role: ChatMessageDto["role"], content: string, status: ChatMessageDto["status"] = "completed", metadata?: Record<string, unknown>): Promise<ChatMessageDto> {
      return messageDto((await db.insert(chatMessages).values({ projectId, chatId, role, content, status, metadataJson: metadata ? JSON.stringify(metadata) : null, createdAt: now() }).returning())[0]);
    },
    async updateMessage(projectId: string, id: number, content: string, status: ChatMessageDto["status"], metadata?: Record<string, unknown>): Promise<void> {
      await db.update(chatMessages).set({ content, status, ...(metadata ? { metadataJson: JSON.stringify(metadata) } : {}) }).where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.id, id)));
    }
  };
}
