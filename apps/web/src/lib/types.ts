export type BizTypeId = 'food' | 'retail' | 'beauty' | 'etc';

export interface BizType {
  id: BizTypeId;
  icon: string;
  label: string;
  template: string;
}

export interface PlatformConnectField {
  key: string;
  label: string;
  min?: number;
  secret?: boolean;
}

export interface PlatformConfig {
  id: string;
  apiSource: string;
  icon: string;
  name: string;
  kind: 'fashion' | 'market' | 'delivery';
  connect: {
    method: 'paste' | 'api';
    note?: string;
    help?: string;
    fields?: PlatformConnectField[];
  };
}

export interface RuleConfig {
  label: string;
  pts: number;
  tone: 'red' | 'gold' | 'green';
  re: string;
}

export interface TopicConfig {
  key: string;
  icon: string;
  name: string;
  re: string;
}

export interface ScenarioConfig {
  id: string;
  label: string;
  heat: number;
  ask: string;
  say: string;
  turns: Array<['cust' | 'ai', string]>;
}

export interface StoreFieldChild {
  key: string;
  type: 'toggle' | 'number' | 'text';
  min?: number;
  max?: number;
}

export interface StoreFieldConfig {
  path: string;
  type: 'toggle' | 'number' | 'text' | 'select' | 'textarea' | 'group' | 'weekly';
  desc?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  readonly?: boolean;
  lines?: boolean;
  options?: Array<{ value: string; label: string }>;
  children?: StoreFieldChild[];
}

export interface StoreSectionConfig {
  id: string;
  api: string;
  icon: string;
  label: string;
  ready: boolean;
  live: boolean;
  note: string;
}

export interface StoreSettingsSchema {
  response: {
    ai_enabled: boolean;
    channels: { chat: boolean; call: boolean };
    heat_threshold: number;
    heat_labels: { high: number; very_high: number };
    min_confidence: number;
    require_grounding: boolean;
    max_ai_replies_per_inquiry: number;
    owner_reply_sla_minutes: number;
    chat_idle_minutes: number;
    debounce_seconds: number;
    ai_disclosure: { enabled: boolean; text: string };
  };
  persona: {
    assistant_name: string;
    formality: 'formal' | 'polite' | 'casual';
    emoji: boolean;
    max_reply_chars: number;
    style_notes: string;
    banned_phrases: string[];
  };
  hours: {
    timezone: string;
    weekly: Record<string, { open: string | null; close: string | null }>;
    holidays: string[];
  };
  voice: {
    enabled: boolean;
    tts: {
      engine: 'vapi' | 'openai' | 'browser';
      voice_name: string;
      rate: number;
      pitch: number;
      instructions: string;
    };
    vapi_voice?: {
      provider: 'azure' | '11labs' | 'openai';
      voice_id: string;
      model: string | null;
    };
    transcriber?: 'deepgram' | 'azure' | 'soniox' | 'openai' | '11labs';
    silence_ms: number;
    noise_suppression?: 'off' | 'standard' | 'strong';
    barge_in: boolean;
    abuse_turn_limit: number;
    max_call_minutes: number;
    recording_notice: boolean;
  };
  ai: {
    model: string;
    judge: string;
    monthly_budget_usd: number | null;
  };
  'data-access': {
    enabled: boolean;
    tools: {
      lookup_order: boolean;
      find_orders: boolean;
      customer_history: boolean;
      track_shipment: boolean;
    };
    max_verify_attempts: number;
    max_lookups_per_inquiry: number;
  };
  instagram: {
    enabled: boolean;
    auto_hide: 'abusive' | 'abusive_or_heated' | 'off';
    hide_heat_gte: number;
    auto_reply: boolean;
  };
  notifications: {
    min_heat_to_notify: number;
    quiet_hours: { enabled: boolean; start: string; end: string };
    priority: {
      urgent_heat_gte: number;
      high_heat_gte: number;
      risk_flag_is_urgent: boolean;
      handoff_is_high: boolean;
    };
    push: { enabled: boolean };
  };
  issues: {
    enabled: boolean;
    min_inquiries: number;
    window_hours: number;
    default_recipients: 'involved' | 'involved_and_list';
  };
  [key: string]: unknown;
}

export interface LocalSettings {
  thHold: number;
  thRepeat: number;
  thHeat: number;
  agent: string;
  tone: string;
  apiUrl: string;
  bizType: BizTypeId;
  storeName: string;
  ownerName: string;
  bizNo: string;
  email?: string;
  platforms: Array<{ id: string; connected: boolean }>;
  onboarded: boolean;
  notices: Record<string, boolean>;
}

export interface CardFacts {
  order_data?: string | null;
  customer_claim?: string | null;
}

export interface CardRecommendation {
  label: string;
  draft: string;
}

export interface InquiryCard {
  summary?: string;
  demands?: string[];
  facts?: CardFacts;
  risk_flags?: string[];
  recommendations?: CardRecommendation[];
}

export interface InquiryItem {
  id: string;
  ts: number;
  customer: string;
  channel: string;
  text: string;
  score: number;
  verdict: 'held' | 'pass';
  hits: string[];
  topic: string | null;
  handled: false | 'auto' | 'sent' | 'manual' | 'ignored';
  handledAt: number | null;
  reply: string;
  replyAt?: number | null;
  draft: string;
  reportedAt: number | null;
  server?: boolean;
  serverStatus?: string;
  snsAction?: 'hidden' | 'replied' | 'none' | null;
  category?: string;
  heatLabel?: string;
  card?: InquiryCard | null;
  cardLoaded?: boolean;
}

export interface IntegrationState {
  channeltalk?: boolean;
  instagram?: boolean;
  [key: string]: unknown;
}

export interface StoreData {
  settings: LocalSettings;
  store: StoreSettingsSchema;
  items: InquiryItem[];
  integrations?: IntegrationState;
  serverSynced?: boolean;
}

export interface PersonInfo {
  key: string;
  label: string;
  sub: string;
  kind: 'name' | 'phone' | 'none';
  icon: string | null;
}

export interface CustomerGroup {
  id: string;
  person: PersonInfo;
  items: InquiryItem[];
  channels: Set<string>;
  last: number;
  worst: number;
  pending: number;
}

export interface RawMessage {
  sender: 'customer' | 'owner' | 'ai' | string;
  text: string;
  created_at?: string;
}

export interface CommerceConnection {
  source: string;
  mode?: string;
  status?: string;
  last_synced_at?: string;
  order_count?: number;
}

export interface InstagramConnection {
  connected?: boolean;
  username?: string;
  ig_user_id?: string;
}

export interface OrderRecord {
  order_no: string;
  customer_name?: string;
  item_name?: string;
  product_name?: string;
  source?: string;
  status?: string;
}

export interface ContextDoc {
  kind: string;
  content_md?: string;
  content?: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  is_active?: boolean;
}

export interface AlertItem {
  id: string;
  title?: string;
  message?: string;
  priority?: string;
  created_at?: string;
}

export interface UrgencyResult {
  score: number;
  label: '긴급' | '주의' | '보통';
  tone: 'red' | 'gold' | 'gray';
}
