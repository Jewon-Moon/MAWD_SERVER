// drizzle/0001_init.sql의 거울 (쿼리 타입용). 테이블을 바꾸면 SQL 마이그레이션과 함께 고칩니다.
import { boolean, date, integer, jsonb, numeric, pgTable, primaryKey, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  webhookToken: text('webhook_token').notNull(),
  channeltalkChannelId: text('channeltalk_channel_id'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  tenantId: uuid('tenant_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull().default('owner'),
});

export const secrets = pgTable('secrets', {
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  ciphertext: text('ciphertext').notNull(),
});

export const issues = pgTable('issues', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  status: text('status').notNull().default('suggested'),
  stibeeEmailId: text('stibee_email_id'),
  createdAt: createdAt(),
});

export const inquiries = pgTable('inquiries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  channel: text('channel', { enum: ['chat', 'call', 'sns'] }).notNull(),
  externalChatId: text('external_chat_id'),
  customerName: text('customer_name'),
  customerEmail: text('customer_email'),
  status: text('status', { enum: ['pending', 'auto_done', 'done', 'manual'] }).notNull().default('pending'),
  route: text('route', { enum: ['A', 'B', 'C'] }),
  issueId: uuid('issue_id'),
  aiMuted: boolean('ai_muted').notNull().default(false),
  verifiedCustomerRef: text('verified_customer_ref'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  inquiryId: uuid('inquiry_id').notNull(),
  externalMessageId: text('external_message_id'),
  sender: text('sender', { enum: ['customer', 'ai', 'owner'] }).notNull(),
  text: text('text').notNull(),
  latencyMs: integer('latency_ms'),
  createdAt: createdAt(),
});

export const analyses = pgTable('analyses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  inquiryId: uuid('inquiry_id').notNull(),
  category: text('category'),
  heat: integer('heat'),
  abuseSpans: jsonb('abuse_spans').notNull().default([]),
  needsOwner: boolean('needs_owner'),
  confidence: real('confidence'),
  raw: jsonb('raw'),
  createdAt: createdAt(),
});

export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  inquiryId: uuid('inquiry_id').notNull(),
  summary: jsonb('summary').notNull(),
  policyRefs: jsonb('policy_refs').notNull().default([]),
  createdAt: createdAt(),
});

export const actions = pgTable('actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  inquiryId: uuid('inquiry_id'),
  actor: text('actor', { enum: ['ai', 'owner', 'system'] }).notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: createdAt(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  sourceType: text('source_type', { enum: ['pdf', 'text', 'url', 'faq'] }).notNull(),
  createdAt: createdAt(),
});

export const docChunks = pgTable('doc_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  content: text('content').notNull(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  orderNo: text('order_no').notNull(),
  customerName: text('customer_name'),
  phone: text('phone'),
  email: text('email'),
  items: text('items'),
  amount: numeric('amount'),
  orderedAt: timestamp('ordered_at', { withTimezone: true }),
  status: text('status'),
  trackingNo: text('tracking_no'),
  eta: date('eta'),
  raw: jsonb('raw'),
});

// drizzle/0002_alerts.sql
export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  inquiryId: uuid('inquiry_id'),
  channel: text('channel', { enum: ['chat', 'call', 'sns'] }).notNull(),
  kind: text('kind', { enum: ['live', 'card'] }).notNull(),
  priority: text('priority', { enum: ['urgent', 'high', 'normal'] }).notNull(),
  heat: integer('heat').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  display: text('display', { enum: ['modal', 'banner', 'toast', 'badge', 'none'] }).notNull(),
  sound: boolean('sound').notNull(),
  pushed: integer('pushed').notNull().default(0),
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: text('user_id'),
  token: text('token').notNull(),
  platform: text('platform', { enum: ['web', 'android', 'ios'] }).notNull(),
  label: text('label'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

// drizzle/0003_context_docs.sql
export const contextDocs = pgTable('context_docs', {
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['business', 'offerings', 'policies'] }).notNull(),
  mode: text('mode', { enum: ['template', 'custom'] }).notNull(),
  fields: jsonb('fields'),
  markdown: text('markdown').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.kind] })]);
