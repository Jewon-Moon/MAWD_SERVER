import { CONFIG } from './config';
import type {
  CustomerGroup,
  InquiryItem,
  LocalSettings,
  PersonInfo,
  UrgencyResult,
} from './types';

export function judgeText(text: string, thHold = 35): { score: number; verdict: 'held' | 'pass'; hits: string[]; topic: string | null } {
  let score = 0;
  const hits: string[] = [];

  for (const r of CONFIG.rules) {
    const re = new RegExp(r.re, 'gi');
    const matches = text.match(re);
    if (matches && matches.length) {
      const mult = matches.length > 1 ? Math.min(2, 1 + (matches.length - 1) * 0.5) : 1;
      score += Math.round(r.pts * mult);
      hits.push(r.label);
    }
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= thHold ? 'held' : 'pass';

  let topic: string | null = null;
  for (const t of CONFIG.topics) {
    if (new RegExp(t.re, 'i').test(text)) {
      topic = t.key;
      break;
    }
  }

  return { score, verdict, hits, topic };
}

export function topicOf(key: string | null) {
  return CONFIG.topics.find((t) => t.key === key) || null;
}

export function summarizeItem(it: InquiryItem): string {
  if (it.card?.summary) return it.card.summary;
  const t = topicOf(it.topic);
  const base = it.text.replace(/\s+/g, ' ').trim();
  const short = base.length > 70 ? base.slice(0, 70) + '…' : base;
  return t ? `[${t.name}] ${short}` : short;
}

export function buildDraft(it: InquiryItem, settings: LocalSettings, storeSettings?: { response?: { owner_reply_sla_minutes?: number } }): string {
  const storeName = settings.storeName || CONFIG.brand.owner;
  const slaMin = storeSettings?.response?.owner_reply_sla_minutes ?? 1440;
  const slaLabel = slaMin <= 120 ? '당일' : slaMin <= 1440 ? '영업일 1일 이내' : '영업일 3일 이내';

  const greet = CONFIG.drafts.greet.replace('{store}', storeName);
  const serious = it.hits.some((h) => h === '협박·위협' || h === '법적 조치 언급');
  const body = serious
    ? CONFIG.drafts.serious
    : (it.topic && CONFIG.drafts.byTopic[it.topic]) || CONFIG.drafts.fallback;
  const closing = CONFIG.drafts.closing.replace('{sla}', slaLabel);

  return `${greet} ${body} ${closing}`;
}

export function normalizePerson(raw: string): PersonInfo {
  const v = (raw || '').trim();
  if (!v) {
    return {
      key: 'unknown',
      label: CONFIG.person.unknownLabel,
      sub: CONFIG.person.unknownSub,
      kind: 'none',
      icon: '?',
    };
  }
  const phoneRe = new RegExp(CONFIG.person.phoneRe);
  if (phoneRe.test(v)) {
    const digits = v.replace(/\D/g, '');
    const masked = CONFIG.person.maskPhone && digits.length >= 7
      ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}`
      : v;
    return {
      key: `phone:${digits}`,
      label: masked,
      sub: CONFIG.person.phoneSub,
      kind: 'phone',
      icon: '📞',
    };
  }
  return {
    key: `name:${v}`,
    label: v,
    sub: '',
    kind: 'name',
    icon: null,
  };
}

export function computeUrgency(it: InquiryItem, repeatCount = 1): UrgencyResult {
  let pts = 0;
  for (const r of CONFIG.urgency.byRule) {
    if (it.hits.includes(r.label)) pts += r.pts;
  }
  if (new RegExp(CONFIG.urgency.money.re, 'i').test(it.text)) {
    pts += CONFIG.urgency.money.pts;
  }
  const rep = Math.max(0, repeatCount - 1);
  pts += Math.min(CONFIG.urgency.perRepeat.max, rep) * CONFIG.urgency.perRepeat.pts;
  pts += CONFIG.urgency.byChannel[it.channel] || 0;

  const lv = CONFIG.urgency.levels.find((l) => pts >= l.min) || CONFIG.urgency.levels[2];
  return { score: pts, label: lv.label, tone: lv.tone };
}

export function groupCustomers(items: InquiryItem[]): CustomerGroup[] {
  const map = new Map<string, CustomerGroup>();
  for (const it of items) {
    const p = normalizePerson(it.customer);
    let g = map.get(p.key);
    if (!g) {
      g = {
        id: p.key,
        person: p,
        items: [],
        channels: new Set(),
        last: it.ts,
        worst: 0,
        pending: 0,
      };
      map.set(p.key, g);
    }
    g.items.push(it);
    g.channels.add(it.channel);
    if (it.ts > g.last) g.last = it.ts;
    if (it.score > g.worst) g.worst = it.score;
    if (!it.handled) g.pending += 1;
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

export function formatAgo(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (diff < 1) return '방금 전';
  if (diff < 60) return `${diff}분 전`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any> | null | undefined): T {
  const out: Record<string, any> = { ...base };
  if (!patch || typeof patch !== 'object') return out as T;
  for (const k of Object.keys(patch)) {
    const bv = out[k];
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out as T;
}
