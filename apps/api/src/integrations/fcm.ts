// FCM(Firebase Cloud Messaging) HTTP v1 발송. 패키지 없이 서비스 계정 JWT → OAuth 토큰 → messages:send
// https://firebase.google.com/docs/cloud-messaging/send/v1-api  (토큰은 1시간 유효, 만료 1분 전에 새로 받음)
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type PushMessage = {
  title: string; body: string; urgent: boolean; highPriority: boolean;
  tag: string; link: string | null; data: Record<string, string>;
};
export type PushResult = 'ok' | 'invalid_token';
export type PushSender = { configured: boolean; send(token: string, m: PushMessage): Promise<PushResult> };

type ServiceAccount = { project_id: string; client_email: string; private_key: string };
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** FIREBASE_SERVICE_ACCOUNT_FILE(서비스 계정 JSON 경로)가 없으면 configured=false (발송은 로그만) */
export function createFcm(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch, log: (m: string) => void = () => {}): PushSender {
  let sa: ServiceAccount | null = null;
  const file = env.FIREBASE_SERVICE_ACCOUNT_FILE?.trim(); // .env에 붙여넣다 끝에 공백이 들어가는 경우가 있음
  try { if (file) sa = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { log(`FCM 서비스 계정 파일을 읽지 못함: ${(e as Error).message}`); }
  let cached: { token: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - 60 > now) return cached.token;
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa!.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa!.private_key).toString('base64url');
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: j.access_token, exp: now + j.expires_in };
    return j.access_token;
  }

  return {
    configured: !!sa,
    async send(token, m) {
      if (!sa) { log(`[FCM 미설정] ${m.title} — ${m.body}`); return 'ok'; }
      const message = {
        token,
        notification: { title: m.title, body: m.body },
        data: m.data,
        android: { priority: m.highPriority ? 'HIGH' : 'NORMAL', notification: { tag: m.tag } },
        apns: { headers: { 'apns-priority': m.highPriority ? '10' : '5' }, payload: { aps: { sound: m.urgent ? 'default' : undefined } } },
        webpush: {
          headers: { Urgency: m.highPriority ? 'high' : 'normal' },
          notification: { tag: m.tag, requireInteraction: m.urgent }, // 긴급은 사용자가 닫을 때까지 남김
          ...(m.link ? { fcm_options: { link: m.link } } : {}),
        },
      };
      const res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }), signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return 'ok';
      const text = await res.text();
      // 앱 삭제 · 권한 철회 등으로 더는 못 받는 토큰 → 호출한 쪽이 지움
      if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|not a valid FCM registration token/i.test(text)) return 'invalid_token'; // 응답 JSON이 여러 줄이라 . 대신 문구로 판단
      throw new Error(`fcm send ${res.status}: ${text.slice(0, 200)}`);
    },
  };
}

/** 브라우저 푸시 등록에 필요한 공개 설정 (Firebase 콘솔 → 프로젝트 설정 → 웹 앱 / 클라우드 메시징). 비밀 값 아님 */
export function webPushConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = { apiKey: env.FIREBASE_WEB_API_KEY?.trim(), projectId: env.FIREBASE_PROJECT_ID?.trim(), messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID?.trim(), appId: env.FIREBASE_WEB_APP_ID?.trim() };
  const vapidKey = env.FIREBASE_VAPID_KEY?.trim();
  return Object.values(c).every(Boolean) && vapidKey ? { firebase: c as Record<keyof typeof c, string>, vapidKey } : null;
}
