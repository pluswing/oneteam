import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ChatMessageDto, ChatSessionDto } from "../../shared/chat";

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), title: text("title").notNull(),
  model: text("model"), effort: text("effort"), threadId: text("thread_id"),
  status: text("status").notNull().$type<ChatSessionDto["status"]>(), error: text("error"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull(), chatId: text("chat_id").notNull(),
  role: text("role").notNull().$type<ChatMessageDto["role"]>(), content: text("content").notNull(),
  status: text("status").notNull().$type<ChatMessageDto["status"]>(), metadataJson: text("metadata_json"), createdAt: text("created_at").notNull()
});
