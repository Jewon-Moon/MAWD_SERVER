import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';

interface PushTokenItem {
  id: string;
  platform: string;
  label?: string | null;
  token_tail?: string;
  last_seen_at?: string;
}

interface ParsedPushConfig {
  enabled: boolean;
  firebaseConfig: Record<string, string> | null;
  vapidKey: string;
}

interface FirebaseMessagingCompat {
  getToken: (options: {
    vapidKey: string;
    serviceWorkerRegistration: ServiceWorkerRegistration;
  }) => Promise<string>;
}

interface FirebaseCompat {
  apps: unknown[];
  initializeApp: (config: Record<string, string>) => unknown;
  messaging: () => FirebaseMessagingCompat;
}

declare global {
  interface Window {
    firebase?: FirebaseCompat;
  }
}

const FIREBASE_APP_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js';
const FIREBASE_MSG_CDN = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js';

const FIREBASE_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
  'measurementId',
] as const;

function parsePushConfig(raw: Record<string, unknown> | null | undefined): ParsedPushConfig {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, firebaseConfig: null, vapidKey: '' };
  }

  const nested =
    raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
      ? (raw.config as Record<string, unknown>)
      : null;

  const source = nested || raw;
  const firebaseConfig: Record<string, string> = {};
  for (const key of FIREBASE_KEYS) {
    const val = source[key];
    if (typeof val === 'string' && val.trim()) {
      firebaseConfig[key] = val.trim();
    }
  }

  const vapidRaw = raw.vapidKey ?? raw.vapid_key ?? source.vapidKey ?? source.vapid_key;
  const vapidKey = typeof vapidRaw === 'string' ? vapidRaw.trim() : '';

  const hasCore = Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      firebaseConfig.messagingSenderId &&
      firebaseConfig.appId &&
      vapidKey
  );

  const enabled = raw.enabled === false ? false : hasCore;

  return {
    enabled,
    firebaseConfig: hasCore ? firebaseConfig : null,
    vapidKey,
  };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`스크립트 로드 실패: ${src}`)), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`스크립트 로드 실패: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureFirebaseMessaging(): Promise<FirebaseCompat> {
  if (!window.firebase) {
    await loadScript(FIREBASE_APP_CDN);
  }
  if (!window.firebase || typeof window.firebase.messaging !== 'function') {
    await loadScript(FIREBASE_MSG_CDN);
  }
  if (!window.firebase || typeof window.firebase.messaging !== 'function') {
    throw new Error('Firebase Messaging SDK를 불러올 수 없습니다');
  }
  return window.firebase;
}

function getPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission;
}

function formatLastSeen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const PushNotificationCard: React.FC = () => {
  const { isAuthed, showToast } = useApp();
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getPermissionState()
  );
  const [loading, setLoading] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [parsedConfig, setParsedConfig] = useState<ParsedPushConfig>({
    enabled: false,
    firebaseConfig: null,
    vapidKey: '',
  });
  const [tokens, setTokens] = useState<PushTokenItem[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);

  const loadPushState = useCallback(async () => {
    if (!isAuthed || !Api.token()) return;
    setLoading(true);
    setConfigError(null);
    try {
      const [cfgRes, tokRes] = await Promise.allSettled([Api.pushConfig(), Api.pushTokens()]);

      if (cfgRes.status === 'fulfilled') {
        setParsedConfig(parsePushConfig(cfgRes.value));
      } else {
        setParsedConfig({ enabled: false, firebaseConfig: null, vapidKey: '' });
        setConfigError('서버 푸시 설정을 불러오지 못했습니다.');
      }

      if (tokRes.status === 'fulfilled') {
        const raw = tokRes.value as unknown;
        const list = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
            ? ((raw as { items?: PushTokenItem[]; tokens?: PushTokenItem[] }).items ??
              (raw as { tokens?: PushTokenItem[] }).tokens ??
              [])
            : [];
        setTokens(list);
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthed]);

  useEffect(() => {
    setPermission(getPermissionState());
    void loadPushState();
  }, [loadPushState]);

  const permissionChip = useMemo(() => {
    switch (permission) {
      case 'granted':
        return { label: '허용됨 (granted)', cls: 'green' };
      case 'denied':
        return { label: '차단됨 (denied)', cls: 'red' };
      case 'default':
        return { label: '미설정 (default)', cls: 'gold' };
      default:
        return { label: '미지원 브라우저', cls: 'gray' };
    }
  }, [permission]);

  const handleEnablePush = async () => {
    if (permission === 'unsupported' || !('serviceWorker' in navigator)) {
      showToast('이 브라우저는 웹 푸시 알림을 지원하지 않습니다');
      return;
    }
    if (!parsedConfig.enabled || !parsedConfig.firebaseConfig || !parsedConfig.vapidKey) {
      showToast('서버 FCM 설정이 준비되지 않았습니다');
      return;
    }

    setEnabling(true);
    try {
      const nextPerm = await Notification.requestPermission();
      setPermission(nextPerm);
      if (nextPerm !== 'granted') {
        showToast(
          nextPerm === 'denied'
            ? '브라우저 알림 권한이 차단되어 있습니다. 브라우저 설정에서 허용해 주세요.'
            : '알림 권한 요청이 취소되었습니다'
        );
        return;
      }

      const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const firebase = await ensureFirebaseMessaging();
      if (!firebase.apps.length) {
        firebase.initializeApp(parsedConfig.firebaseConfig);
      }

      const fcmToken = await firebase.messaging().getToken({
        vapidKey: parsedConfig.vapidKey,
        serviceWorkerRegistration: swReg,
      });

      if (!fcmToken) {
        throw new Error('FCM 토큰을 발급받지 못했습니다');
      }

      await Api.registerPushToken(fcmToken, 'web', navigator.userAgent.slice(0, 40));
      showToast('이 브라우저의 푸시 알림이 활성화되었습니다');
      await loadPushState();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '푸시 알림 등록에 실패했습니다');
    } finally {
      setEnabling(false);
    }
  };

  const handleDeleteToken = async (id: string) => {
    setDeletingId(id);
    try {
      await Api.deletePushToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      showToast('기기 푸시 알림을 해제했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '기기 해제에 실패했습니다');
    } finally {
      setDeletingId(null);
    }
  };

  if (!isAuthed) {
    return (
      <div className="card">
        <div className="row-t1">브라우저 푸시 알림 (FCM)</div>
        <div className="note" style={{ marginTop: 10 }}>
          로그인 후 브라우저 푸시 알림을 설정할 수 있습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="row-t1" style={{ fontSize: 15 }}>
            브라우저 푸시 알림 (FCM)
          </div>
          <div className="row-t2" style={{ marginTop: 2 }}>
            긴급 문의나 보류 알림이 도착하면 이 기기로 즉시 푸시 알림을 보냅니다.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className={`chip ${permissionChip.cls}`}>브라우저: {permissionChip.label}</span>
          <span className={`chip ${parsedConfig.enabled ? 'blue' : 'gray'}`}>
            {parsedConfig.enabled ? '서버 FCM 준비됨' : '서버 FCM 미설정'}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="note" style={{ marginTop: 12 }}>
          푸시 설정을 확인하는 중...
        </div>
      ) : !parsedConfig.enabled ? (
        <div className="note gold" style={{ marginTop: 12 }}>
          {configError ||
            '서버에 Firebase 웹 푸시(FCM) 설정이 등록되어 있지 않아 브라우저 푸시를 켤 수 없습니다. 관리자에게 FCM 환경변수 설정을 요청해 주세요.'}
        </div>
      ) : permission === 'denied' ? (
        <div className="note red" style={{ marginTop: 12 }}>
          브라우저에서 알림 권한이 차단되어 있습니다. 주소창 왼쪽 자물쇠 아이콘에서 알림을
          ‘허용’으로 변경한 뒤 다시 시도해 주세요.
        </div>
      ) : null}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn sm"
          disabled={
            enabling ||
            loading ||
            !parsedConfig.enabled ||
            permission === 'unsupported' ||
            permission === 'denied'
          }
          onClick={handleEnablePush}
        >
          {enabling ? '등록 중...' : '이 브라우저 푸시 알림 켜기'}
        </button>
      </div>

      <div style={{ marginTop: 18 }}>
        <div className="label" style={{ marginBottom: 8 }}>
          등록된 알림 기기 ({tokens.length})
        </div>
        {tokens.length === 0 ? (
          <div className="row-t2">아직 등록된 푸시 기기가 없습니다.</div>
        ) : (
          <div className="list">
            {tokens.map((tok) => {
              const seen = formatLastSeen(tok.last_seen_at);
              return (
                <div key={tok.id} className="row">
                  <div className="ico-box" aria-hidden="true">
                    {tok.platform === 'web' ? '💻' : '📱'}
                  </div>
                  <div className="row-body">
                    <div className="row-t1">
                      <span>{tok.label || `${tok.platform} 기기`}</span>
                      <span className="chip gray">{tok.platform}</span>
                    </div>
                    <div className="row-t2">
                      {tok.token_tail ? `토큰 끝자리 ···${tok.token_tail}` : '등록된 토큰'}
                      {seen ? ` · 최근 확인: ${seen}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={deletingId === tok.id}
                    onClick={() => handleDeleteToken(tok.id)}
                  >
                    {deletingId === tok.id ? '해제 중...' : '해제'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
