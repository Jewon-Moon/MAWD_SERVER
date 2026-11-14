// 택배사 실시간 배송 조회: Delivery Tracker (tracker.delivery) GraphQL API. CJ대한통운 · 우체국 · 한진 · 롯데 · 로젠 등 국내 주요 택배사.
// 인증: Authorization: TRACKQL-API-KEY {client_id}:{client_secret}  (https://tracker.delivery/docs/authentication)
// 키가 없거나 실패하면 null → 주문 데이터의 상태(status · eta)로만 안내
export type Delivery = { status: string; status_code: string; last_event_at: string | null; last_event: string | null; location: string | null };
export type Tracker = { configured: boolean; track(carrier: string, trackingNo: string): Promise<Delivery | null> };

// 매장이 주문 데이터에 적는 택배사 이름 → Delivery Tracker 택배사 ID. 이미 ID("kr.…")면 그대로
const CARRIER_IDS: Record<string, string> = {
  'cj대한통운': 'kr.cjlogistics', 'cj': 'kr.cjlogistics', '대한통운': 'kr.cjlogistics',
  '우체국': 'kr.epost', '우체국택배': 'kr.epost',
  '한진': 'kr.hanjin', '한진택배': 'kr.hanjin',
  '롯데': 'kr.lotte', '롯데택배': 'kr.lotte', '롯데글로벌로지스': 'kr.lotte',
  '로젠': 'kr.logen', '로젠택배': 'kr.logen',
  '경동': 'kr.kdexp', '경동택배': 'kr.kdexp',
  '대신': 'kr.daesin', '대신택배': 'kr.daesin',
  '일양': 'kr.ilyanglogis', '일양로지스': 'kr.ilyanglogis',
  '합동': 'kr.hdexp', '합동택배': 'kr.hdexp',
  'cu편의점택배': 'kr.cupost', 'gs편의점택배': 'kr.cvsnet', 'gs postbox': 'kr.cvsnet',
};
export const carrierId = (carrier: string) => {
  const c = carrier.trim();
  return c.startsWith('kr.') || c.includes('.') ? c : CARRIER_IDS[c.toLowerCase().replace(/\s+/g, '')] ?? CARRIER_IDS[c.toLowerCase()] ?? null;
};
// 고객에게 말할 상태 (택배사 코드 → 한국어)
const STATUS_KO: Record<string, string> = {
  INFORMATION_RECEIVED: '송장 등록됨 (아직 집하 전)', AT_PICKUP: '집하 완료', IN_TRANSIT: '배송 중 (이동 중)',
  OUT_FOR_DELIVERY: '배송 출발 (오늘 도착 예정)', ATTEMPT_FAIL: '배송 시도 실패', DELIVERED: '배송 완료',
  AVAILABLE_FOR_PICKUP: '수령 대기 (보관 중)', EXCEPTION: '배송 이상 (택배사 확인 필요)', UNKNOWN: '확인 중',
};

const QUERY = `query Track($carrierId: ID!, $trackingNumber: String!) {
  track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
    lastEvent { time status { code name } description location { name } }
  }
}`;

export function createTracker(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Tracker {
  const id = env.TRACKER_CLIENT_ID?.trim(), secret = env.TRACKER_CLIENT_SECRET?.trim();
  // shortcut: 프로세스 메모리 5분 캐시 (같은 송장을 한 통화에서 여러 번 묻는 경우). 서버 여러 대면 Redis
  const cache = new Map<string, { at: number; v: Delivery | null }>();
  return {
    configured: !!(id && secret),
    async track(carrier, trackingNo) {
      const cid = carrierId(carrier);
      if (!id || !secret || !cid) return null;
      const no = trackingNo.replace(/\D/g, '');
      const key = `${cid}:${no}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
      try {
        const res = await fetchFn('https://apis.tracker.delivery/graphql', {
          method: 'POST',
          headers: { authorization: `TRACKQL-API-KEY ${id}:${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: QUERY, variables: { carrierId: cid, trackingNumber: no } }),
          signal: AbortSignal.timeout(4_000), // 통화 중이라 오래 못 기다림 (문서 권장 최대 15초)
        });
        const j = (await res.json()) as { data?: { track?: { lastEvent?: { time?: string; status?: { code?: string; name?: string }; description?: string; location?: { name?: string } } | null } | null }; errors?: unknown[] };
        const e = j.data?.track?.lastEvent;
        const v: Delivery | null = !res.ok || j.errors?.length || !e ? null : {
          status_code: e.status?.code ?? 'UNKNOWN',
          status: STATUS_KO[e.status?.code ?? 'UNKNOWN'] ?? e.status?.name ?? '확인 중',
          last_event_at: e.time ?? null, last_event: e.description ?? null, location: e.location?.name ?? null,
        };
        cache.set(key, { at: Date.now(), v });
        return v;
      } catch { return null; }
    },
  };
}
