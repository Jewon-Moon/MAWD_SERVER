import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG } from '../lib/config';
import { buildDraft, judgeText } from '../lib/judge';
import type { InquiryCard, ScenarioConfig } from '../lib/types';

type TestTab = 'phone' | 'chat';

interface TranscriptMsg {
  id: string;
  role: 'cust' | 'ai';
  text: string;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence?: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function formatTimer(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function heatBadge(
  score: number,
  threshold: number,
  veryHigh: number,
  overrideLabel?: string
): { label: string; tone: 'red' | 'gold' | 'green' } {
  if (score >= veryHigh) return { label: overrideLabel || `매우 높음 (${score}점)`, tone: 'red' };
  if (score >= threshold) return { label: overrideLabel || `격앙 (${score}점)`, tone: 'gold' };
  return { label: overrideLabel || `보통 (${score}점)`, tone: 'green' };
}

function normalizeCard(raw: unknown): InquiryCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const cardObj = (obj.card && typeof obj.card === 'object' ? obj.card : obj) as Record<string, unknown>;
  const summary = typeof cardObj.summary === 'string' ? cardObj.summary : undefined;
  const demands = Array.isArray(cardObj.demands) ? cardObj.demands.map(String) : undefined;
  const riskFlags = Array.isArray(cardObj.risk_flags) ? cardObj.risk_flags.map(String) : undefined;
  const facts =
    cardObj.facts && typeof cardObj.facts === 'object'
      ? (cardObj.facts as InquiryCard['facts'])
      : undefined;
  const recommendations = Array.isArray(cardObj.recommendations)
    ? (cardObj.recommendations as InquiryCard['recommendations'])
    : undefined;

  if (!summary && !demands?.length && !riskFlags?.length && !facts && !recommendations?.length) {
    return null;
  }
  return { summary, demands, facts, risk_flags: riskFlags, recommendations };
}

const SummaryCardBlock: React.FC<{ title: string; card: InquiryCard }> = ({ title, card }) => (
  <div className="card" style={{ marginTop: 16 }}>
    <div className="sec-head" style={{ marginBottom: 10 }}>
      <h2>{title}</h2>
      <span className="chip blue">요약 완료</span>
    </div>

    {card.summary && <div className="quote">{card.summary}</div>}

    {card.demands && card.demands.length > 0 && (
      <div className="detail-block">
        <div className="detail-block-title">고객 요구사항</div>
        <div className="btn-row" style={{ gap: 6 }}>
          {card.demands.map((d, idx) => (
            <span key={`${d}-${idx}`} className="chip gold">
              {d}
            </span>
          ))}
        </div>
      </div>
    )}

    {card.facts && (card.facts.order_data || card.facts.customer_claim) && (
      <div className="detail-block">
        <div className="detail-block-title">확인된 사실</div>
        <div className="fact-grid">
          {card.facts.order_data && (
            <div className="fact-item">
              <div className="fact-label">주문 데이터</div>
              <div className="fact-val">{card.facts.order_data}</div>
            </div>
          )}
          {card.facts.customer_claim && (
            <div className="fact-item">
              <div className="fact-label">고객 주장</div>
              <div className="fact-val">{card.facts.customer_claim}</div>
            </div>
          )}
        </div>
      </div>
    )}

    {card.risk_flags && card.risk_flags.length > 0 && (
      <div className="detail-block">
        <div className="detail-block-title">위험 신호</div>
        <div className="btn-row" style={{ gap: 6 }}>
          {card.risk_flags.map((flag, idx) => (
            <span key={`${flag}-${idx}`} className="chip red">
              {flag}
            </span>
          ))}
        </div>
      </div>
    )}

    {card.recommendations && card.recommendations.length > 0 && (
      <div className="detail-block">
        <div className="detail-block-title">추천 후속 대응</div>
        {card.recommendations.map((rec, idx) => (
          <div key={`${rec.label}-${idx}`} className="rec-card">
            <div className="rec-head">
              <strong style={{ fontSize: 13.5 }}>{rec.label}</strong>
            </div>
            <div className="rec-draft">{rec.draft}</div>
          </div>
        ))}
      </div>
    )}
  </div>
);

export const TestPage: React.FC = () => {
  const { data, pullServer, showToast } = useApp();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<TestTab>(() =>
    searchParams.get('tab') === 'chat' ? 'chat' : 'phone'
  );

  const heatThreshold = data.store.response.heat_threshold || data.settings.thHold || 40;
  const veryHighThreshold = data.store.response.heat_labels?.very_high || 70;

  /* ── Phone tab state ── */
  const [callId, setCallId] = useState<string | null>(null);
  const [callActive, setCallActive] = useState<boolean>(false);
  const [callSec, setCallSec] = useState<number>(0);
  const [callHeat, setCallHeat] = useState<number>(0);
  const [callHeatLabel, setCallHeatLabel] = useState<string>('');
  const [p50Ms, setP50Ms] = useState<number | null>(null);
  const [voiceInput, setVoiceInput] = useState<string>('');
  const [voiceBusy, setVoiceBusy] = useState<boolean>(false);
  const [muted, setMuted] = useState<boolean>(false);
  const [listening, setListening] = useState<boolean>(false);
  const [callTape, setCallTape] = useState<TranscriptMsg[]>([]);
  const [callSummary, setCallSummary] = useState<InquiryCard | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef<boolean>(false);
  const mutedRef = useRef<boolean>(muted);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const callTapeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  /* ── Chat tab state ── */
  const [chatId, setChatId] = useState<string>(() => `test-chat-${Date.now()}`);
  const [chatWho, setChatWho] = useState<string>('김민수');
  const [chatInput, setChatInput] = useState<string>('');
  const [chatBusy, setChatBusy] = useState<boolean>(false);
  const [chatEnded, setChatEnded] = useState<boolean>(false);
  const [chatTape, setChatTape] = useState<TranscriptMsg[]>([]);
  const [chatSummary, setChatSummary] = useState<InquiryCard | null>(null);
  const chatTapeRef = useRef<HTMLDivElement | null>(null);

  /* ── Call timer ── */
  useEffect(() => {
    if (!callActive) return;
    const timer = window.setInterval(() => {
      setCallSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callActive]);

  /* ── Auto-scroll tapes ── */
  useEffect(() => {
    if (callTapeRef.current) {
      callTapeRef.current.scrollTop = callTapeRef.current.scrollHeight;
    }
  }, [callTape]);

  useEffect(() => {
    if (chatTapeRef.current) {
      chatTapeRef.current.scrollTop = chatTapeRef.current.scrollHeight;
    }
  }, [chatTape]);

  /* ── Stop all TTS playback (barge-in / mute / hangup) ── */
  const stopTts = useCallback(() => {
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  useEffect(() => {
    if (muted) stopTts();
  }, [muted, stopTts]);

  useEffect(() => {
    return () => {
      stopTts();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, [stopTts]);

  const speakWithBrowser = useCallback(
    (text: string): Promise<void> => {
      return new Promise((resolve) => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
          resolve();
          return;
        }
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'ko-KR';
        utter.rate = data.store.voice?.tts?.rate || 1.05;
        utter.onend = () => resolve();
        utter.onerror = () => resolve();
        window.speechSynthesis.speak(utter);
      });
    },
    [data.store.voice?.tts?.rate]
  );

  const drainTtsQueue = useCallback(async () => {
    if (ttsPlayingRef.current || mutedRef.current) return;
    ttsPlayingRef.current = true;
    try {
      while (ttsQueueRef.current.length > 0 && !mutedRef.current) {
        const nextText = ttsQueueRef.current.shift();
        if (!nextText) continue;

        const url = Api.token() ? await Api.ttsUrl(nextText) : null;
        if (mutedRef.current) break;

        if (url) {
          await new Promise<void>((resolve) => {
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => {
              if (audioRef.current === audio) audioRef.current = null;
              resolve();
            };
            audio.onerror = () => {
              if (audioRef.current === audio) audioRef.current = null;
              void speakWithBrowser(nextText).then(resolve);
            };
            audio.play().catch(() => {
              if (audioRef.current === audio) audioRef.current = null;
              void speakWithBrowser(nextText).then(resolve);
            });
          });
        } else {
          await speakWithBrowser(nextText);
        }
      }
    } finally {
      ttsPlayingRef.current = false;
    }
  }, [speakWithBrowser]);

  const enqueueTts = useCallback(
    (text: string) => {
      if (mutedRef.current || !text.trim()) return;
      ttsQueueRef.current.push(text.trim());
      void drainTtsQueue();
    },
    [drainTtsQueue]
  );

  const appendCallMsg = useCallback((role: 'cust' | 'ai', text: string) => {
    setCallTape((prev) => [
      ...prev,
      { id: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role, text },
    ]);
  }, []);

  /* ── Start & End Call ── */
  const handleStartCall = async () => {
    stopTts();
    setCallSummary(null);
    setCallTape([]);
    setCallSec(0);
    setCallHeat(0);
    setCallHeatLabel('');
    setP50Ms(null);

    if (!Api.token()) {
      const offlineId = `offline-call-${Date.now()}`;
      setCallId(offlineId);
      setCallActive(true);
      const greet = data.store.response.ai_disclosure.enabled
        ? `안녕하세요, ${data.settings.storeName || CONFIG.brand.owner} AI 상담 도우미입니다. 무엇을 도와드릴까요?`
        : '안녕하세요, 무엇을 도와드릴까요?';
      appendCallMsg('ai', greet);
      enqueueTts(greet);
      showToast('오프라인 시연 통화를 시작했습니다');
      return;
    }

    try {
      const res = await Api.startCall();
      setCallId(res.call_id);
      setCallActive(true);
      const greet =
        res.greeting_text ||
        `안녕하세요, ${data.settings.storeName || CONFIG.brand.owner}입니다. 무엇을 도와드릴까요?`;
      appendCallMsg('ai', greet);
      enqueueTts(greet);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '통화 시작에 실패했습니다';
      showToast(msg);
    }
  };

  const handleEndCall = async () => {
    stopTts();
    if (recognitionRef.current && listening) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setListening(false);
    }

    const activeId = callId;
    setCallActive(false);

    if (!activeId) return;

    if (!Api.token() || activeId.startsWith('offline-')) {
      const custTexts = callTape.filter((m) => m.role === 'cust').map((m) => m.text).join(' ');
      const j = judgeText(custTexts, heatThreshold);
      setCallSummary({
        summary: custTexts
          ? `통화 시연 요약: ${custTexts.slice(0, 80)}${custTexts.length > 80 ? '…' : ''}`
          : '통화가 종료되었습니다.',
        demands: j.topic ? [j.topic] : ['일반 문의'],
        risk_flags: j.hits,
        recommendations: [
          {
            label: '후속 안내',
            draft: buildDraft(
              {
                id: activeId,
                ts: Date.now(),
                customer: '전화 고객',
                channel: '전화',
                text: custTexts,
                score: j.score,
                verdict: j.verdict,
                hits: j.hits,
                topic: j.topic,
                handled: false,
                handledAt: null,
                reply: '',
                draft: '',
                reportedAt: null,
              },
              data.settings,
              data.store
            ),
          },
        ],
      });
      showToast('통화를 끊었습니다');
      return;
    }

    try {
      const endRes = await Api.endCall(activeId);
      const immediateCard = normalizeCard(endRes);
      if (immediateCard) {
        setCallSummary(immediateCard);
        void pullServer();
        showToast('통화를 끊고 요약 카드를 생성했습니다');
        return;
      }

      // Poll up to 8 times for post-call summary
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => window.setTimeout(r, 1000));
        try {
          const detail = (await Api.getCall(activeId)) as Record<string, unknown>;
          const card = normalizeCard(detail);
          if (card || detail?.status === 'ended' || detail?.status === 'completed') {
            if (card) setCallSummary(card);
            break;
          }
        } catch {
          // continue polling
        }
      }
      void pullServer();
      showToast('통화를 끊었습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '통화 종료 처리에 실패했습니다';
      showToast(msg);
    }
  };

  /* ── Send Voice Turn (SSE streaming + offline fallback) ── */
  const sendVoiceTurn = useCallback(
    async (text: string, offlineScenario?: ScenarioConfig) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Barge-in support: stop current AI audio when customer speaks
      if (data.store.voice?.barge_in !== false) {
        stopTts();
      }

      appendCallMsg('cust', trimmed);
      setVoiceBusy(true);

      const tok = Api.token();
      if (!tok || !callId || callId.startsWith('offline-')) {
        const j = judgeText(trimmed, heatThreshold);
        setCallHeat((prev) => Math.max(prev, offlineScenario?.heat ?? j.score));
        const reply =
          offlineScenario?.turns.find(([who]) => who === 'ai')?.[1] ||
          buildDraft(
            {
              id: 'offline-turn',
              ts: Date.now(),
              customer: '전화 고객',
              channel: '전화',
              text: trimmed,
              score: j.score,
              verdict: j.verdict,
              hits: j.hits,
              topic: j.topic,
              handled: false,
              handledAt: null,
              reply: '',
              draft: '',
              reportedAt: null,
            },
            data.settings,
            data.store
          );
        appendCallMsg('ai', reply);
        enqueueTts(reply);
        setVoiceBusy(false);
        return;
      }

      try {
        const res = await fetch(`${Api.base()}/v1/calls/${encodeURIComponent(callId)}/turns`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok}`,
          },
          credentials: 'include',
          body: JSON.stringify({ text: trimmed }),
        });

        if (!res.ok || !res.body) {
          throw new Error(`음성 턴 전송 실패 (HTTP ${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let streamingMsgId: string | null = null;
        let accumulatedAi = '';

        const processPayload = (evType: string, payloadStr: string) => {
          if (!payloadStr || payloadStr === '[DONE]') return;
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(payloadStr) as Record<string, unknown>;
          } catch {
            // plain text fallback
            if (evType === 'sentence') {
              accumulatedAi += (accumulatedAi ? ' ' : '') + payloadStr;
              enqueueTts(payloadStr);
            }
            return;
          }

          const type = (parsed.type as string) || evType;

          if (type === 'state') {
            const heatObj = parsed.heat as { score?: number; label?: string } | undefined;
            const sc =
              typeof parsed.heat_score === 'number'
                ? parsed.heat_score
                : typeof heatObj?.score === 'number'
                ? heatObj.score
                : typeof parsed.score === 'number'
                ? parsed.score
                : null;
            if (sc !== null) setCallHeat(sc);
            if (typeof heatObj?.label === 'string') setCallHeatLabel(heatObj.label);
            else if (typeof parsed.heat_label === 'string') setCallHeatLabel(parsed.heat_label);
          } else if (type === 'sentence') {
            const sentence = String(parsed.text || parsed.sentence || '');
            if (sentence) {
              accumulatedAi += (accumulatedAi ? ' ' : '') + sentence;
              if (!streamingMsgId) {
                streamingMsgId = `ai-${Date.now()}`;
                const msgId = streamingMsgId;
                setCallTape((prev) => [...prev, { id: msgId, role: 'ai', text: accumulatedAi }]);
              } else {
                const msgId = streamingMsgId;
                setCallTape((prev) =>
                  prev.map((m) => (m.id === msgId ? { ...m, text: accumulatedAi } : m))
                );
              }
              enqueueTts(sentence);
            }
          } else if (type === 'metrics') {
            const p50 =
              typeof parsed.p50_ms === 'number'
                ? parsed.p50_ms
                : typeof parsed.p50 === 'number'
                ? parsed.p50
                : typeof parsed.latency_ms === 'number'
                ? parsed.latency_ms
                : null;
            if (p50 !== null) setP50Ms(Math.round(p50));
          } else if (type === 'done') {
            const finalReply = typeof parsed.reply === 'string' ? parsed.reply : '';
            if (finalReply && !accumulatedAi) {
              appendCallMsg('ai', finalReply);
              enqueueTts(finalReply);
            }
          } else if (type === 'error') {
            const errMsg = String(parsed.message || parsed.detail || '응답 생성 중 오류가 발생했습니다');
            showToast(errMsg);
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) {
              currentEvent = '';
              continue;
            }
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              processPayload(currentEvent, line.slice(5).trim());
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '음성 턴 처리 중 오류가 발생했습니다';
        showToast(msg);
      } finally {
        setVoiceBusy(false);
      }
    },
    [appendCallMsg, callId, data.settings, data.store, enqueueTts, heatThreshold, showToast, stopTts]
  );

  const handleVoiceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!voiceInput.trim() || !callActive || voiceBusy) return;
    const txt = voiceInput;
    setVoiceInput('');
    void sendVoiceTurn(txt);
  };

  const releaseMicStream = () => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
  };

  /* ── Web Speech API Mic Toggle ── */
  const toggleMic = async () => {
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      releaseMicStream();
      setListening(false);
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      showToast('이 브라우저는 음성 인식을 지원하지 않아요. 텍스트 입력을 이용해 주세요.');
      return;
    }

    if (data.store.voice?.barge_in !== false) {
      stopTts();
    }

    // 브라우저 하드웨어 에코 제거 · 잡음 억제 · 자동 게인 활성화
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        releaseMicStream();
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch {
        // 권한 거부 등이면 SpeechRecognition 자체 흐름으로 폴백
      }
    }

    const rec = new Ctor();
    rec.lang = 'ko-KR';
    rec.interimResults = false;
    rec.continuous = false;

    rec.onresult = (ev) => {
      const lastIdx = ev.results.length - 1;
      const alt = ev.results[lastIdx]?.[0];
      const transcript = alt?.transcript?.trim();
      const conf = alt?.confidence;
      if (typeof conf === 'number' && conf > 0 && conf < 0.35) {
        return;
      }
      if (transcript) {
        void sendVoiceTurn(transcript);
      }
    };
    rec.onerror = () => {
      releaseMicStream();
      setListening(false);
      showToast('음성 인식 중 오류가 발생했습니다');
    };
    rec.onend = () => {
      releaseMicStream();
      setListening(false);
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      showToast('마이크를 시작할 수 없습니다');
    }
  };

  /* ── Chat tab handlers ── */
  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || chatBusy || chatEnded) return;

    setChatInput('');
    setChatTape((prev) => [
      ...prev,
      { id: `ch-c-${Date.now()}`, role: 'cust', text: trimmed },
    ]);
    setChatBusy(true);

    if (!Api.token()) {
      const j = judgeText(trimmed, heatThreshold);
      const reply =
        j.verdict === 'held'
          ? '말씀해 주신 내용은 담당자에게 바로 전달했습니다. 확인 후 연락드리겠습니다.'
          : buildDraft(
              {
                id: chatId,
                ts: Date.now(),
                customer: chatWho || '고객',
                channel: '채널톡',
                text: trimmed,
                score: j.score,
                verdict: j.verdict,
                hits: j.hits,
                topic: j.topic,
                handled: false,
                handledAt: null,
                reply: '',
                draft: '',
                reportedAt: null,
              },
              data.settings,
              data.store
            );
      setChatTape((prev) => [
        ...prev,
        { id: `ch-a-${Date.now()}`, role: 'ai', text: reply },
      ]);
      setChatBusy(false);
      return;
    }

    try {
      const res = (await Api.sendChatMessage(chatId, trimmed, chatWho.trim() || undefined)) as Record<
        string,
        unknown
      > | null;
      const aiText =
        (typeof res?.reply === 'string' && res.reply) ||
        (typeof res?.ai_reply === 'string' && res.ai_reply) ||
        (typeof res?.text === 'string' && res.text) ||
        (typeof res?.message === 'string' && res.message) ||
        '';
      if (aiText) {
        setChatTape((prev) => [
          ...prev,
          { id: `ch-a-${Date.now()}`, role: 'ai', text: aiText },
        ]);
      }
      void pullServer();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '메시지 전송에 실패했습니다';
      showToast(msg);
    } finally {
      setChatBusy(false);
    }
  };

  const handleEndChat = async () => {
    if (chatEnded || chatTape.length === 0) return;
    setChatBusy(true);

    if (!Api.token()) {
      const allText = chatTape.filter((m) => m.role === 'cust').map((m) => m.text).join(' ');
      const j = judgeText(allText, heatThreshold);
      setChatSummary({
        summary: `${chatWho || '고객'}님과의 채널톡 대화 요약: ${allText.slice(0, 80)}${allText.length > 80 ? '…' : ''}`,
        demands: j.topic ? [j.topic] : ['일반 문의'],
        risk_flags: j.hits,
      });
      setChatEnded(true);
      setChatBusy(false);
      showToast('대화를 종료했습니다');
      return;
    }

    try {
      const res = await Api.endChat(chatId);
      const card = normalizeCard(res);
      if (card) {
        setChatSummary(card);
      } else {
        setChatSummary({ summary: '대화가 종료되어 요약 카드가 저장되었습니다.' });
      }
      setChatEnded(true);
      void pullServer();
      showToast('대화를 종료하고 요약 카드를 생성했습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '대화 종료에 실패했습니다';
      showToast(msg);
    } finally {
      setChatBusy(false);
    }
  };

  const handleResetChat = () => {
    setChatId(`test-chat-${Date.now()}`);
    setChatTape([]);
    setChatSummary(null);
    setChatEnded(false);
  };

  const meter = heatBadge(callHeat, heatThreshold, veryHighThreshold, callHeatLabel || undefined);

  return (
    <Layout title="고객 시연 (테스트)" subtitle="전화 걸기 및 채널톡 채팅 테스트" backTo="/">
      <div style={{ marginBottom: 20 }}>
        <div className="seg" role="tablist" aria-label="테스트 채널 선택">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'phone'}
            className={`seg-btn ${tab === 'phone' ? 'is-active' : ''}`}
            onClick={() => setTab('phone')}
          >
            📞 전화 걸기
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={`seg-btn ${tab === 'chat' ? 'is-active' : ''}`}
            onClick={() => setTab('chat')}
          >
            💬 채널톡 채팅
          </button>
        </div>
      </div>

      {tab === 'phone' ? (
        <section className="sec">
          {/* 상단 통화 제어 및 상태 */}
          <div className="card">
            <div className="row" style={{ padding: 0, borderBottom: 'none', flexWrap: 'wrap' }}>
              <div className="row-body">
                <div className="row-t1">
                  <span>{callActive ? '통화 연결 중' : '통화 대기 중'}</span>
                  <span className="chip gray">{formatTimer(callSec)}</span>
                  <span className={`chip ${meter.tone}`}>{meter.label}</span>
                  {p50Ms !== null && <span className="chip blue">p50 {p50Ms}ms</span>}
                </div>
                <div className="row-t2">
                  {callId ? `세션 ID: ${callId}` : '전화 걸기 버튼을 눌러 실시간 AI 전화 응대를 테스트해 보세요.'}
                </div>
              </div>

              <div className="btn-row">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setMuted((m) => !m)}
                >
                  {muted ? '🔇 음소거 해제' : '🔊 음성 켜짐'}
                </button>
                {!callActive ? (
                  <button type="button" className="btn sm" onClick={() => void handleStartCall()}>
                    📞 전화 걸기
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => void handleEndCall()}
                  >
                    통화 끊기
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 시나리오 빠른 실행 */}
          <div className="card">
            <div className="detail-block-title" style={{ marginBottom: 10 }}>
              시나리오 빠른 실행
            </div>
            <div className="btn-row">
              {CONFIG.scenarios.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  className="btn ghost sm"
                  disabled={!callActive || voiceBusy}
                  onClick={() => void sendVoiceTurn(sc.say, sc)}
                  title={sc.ask}
                >
                  {sc.label}
                </button>
              ))}
            </div>
          </div>

          {/* 대화 테이프 + 음성/텍스트 입력 */}
          <div className="card">
            <div className="tape" ref={callTapeRef} aria-live="polite">
              {callTape.length === 0 ? (
                <div className="hint" style={{ textAlign: 'center', margin: '24px 0' }}>
                  전화 걸기를 누르면 고객과 AI의 대화 기록이 이곳에 실시간으로 표시됩니다.
                </div>
              ) : (
                callTape.map((msg) => (
                  <div key={msg.id} className={`msg ${msg.role === 'cust' ? 'cust' : ''}`}>
                    <div className="msg-av">{msg.role === 'cust' ? '고' : 'AI'}</div>
                    <div className="bubble">{msg.text}</div>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleVoiceSubmit} style={{ marginTop: 14 }}>
              <div className="btn-row">
                <button
                  type="button"
                  className={`btn sm ${listening ? 'danger' : 'ghost'}`}
                  onClick={toggleMic}
                  disabled={!callActive || voiceBusy}
                >
                  {listening ? '🎙 듣는 중...' : '🎙 마이크'}
                </button>
                <input
                  type="text"
                  className="input"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder={
                    callActive
                      ? '고객 발화를 입력하거나 마이크를 눌러 말해보세요...'
                      : '먼저 전화 걸기 버튼을 눌러주세요'
                  }
                  value={voiceInput}
                  onChange={(e) => setVoiceInput(e.target.value)}
                  disabled={!callActive || voiceBusy}
                />
                <button
                  type="submit"
                  className="btn sm"
                  disabled={!callActive || voiceBusy || !voiceInput.trim()}
                >
                  {voiceBusy ? '응답 중...' : '전송'}
                </button>
              </div>
            </form>
          </div>

          {callSummary && <SummaryCardBlock title="통화 종료 요약 카드" card={callSummary} />}
        </section>
      ) : (
        <section className="sec">
          {/* 채팅 설정 및 샘플 */}
          <div className="card">
            <div className="field">
              <label className="label" htmlFor="test-chat-who">
                고객 이름
              </label>
              <div className="btn-row">
                <input
                  id="test-chat-who"
                  type="text"
                  className="input"
                  style={{ flex: 1, minWidth: 180 }}
                  value={chatWho}
                  onChange={(e) => setChatWho(e.target.value)}
                  placeholder="고객 이름 입력"
                  disabled={chatEnded}
                />
                {!chatEnded ? (
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => void handleEndChat()}
                    disabled={chatBusy || chatTape.length === 0}
                  >
                    대화 종료
                  </button>
                ) : (
                  <button type="button" className="btn sm" onClick={handleResetChat}>
                    새 대화 시작
                  </button>
                )}
              </div>
            </div>

            <div className="detail-block-title" style={{ marginBottom: 8 }}>
              샘플 메시지 채우기
            </div>
            <div className="btn-row" style={{ gap: 6 }}>
              {CONFIG.samples.map(([label, sampleText]) => (
                <button
                  key={label}
                  type="button"
                  className="chip gray"
                  style={{ cursor: 'pointer', padding: '6px 12px' }}
                  onClick={() => setChatInput(sampleText)}
                  disabled={chatEnded}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 채팅 히스토리 & 입력 */}
          <div className="card">
            <div className="tape" ref={chatTapeRef} aria-live="polite">
              {chatTape.length === 0 ? (
                <div className="hint" style={{ textAlign: 'center', margin: '24px 0' }}>
                  샘플을 선택하거나 메시지를 입력해 채널톡 AI 응대를 테스트해 보세요.
                </div>
              ) : (
                chatTape.map((msg) => (
                  <div key={msg.id} className={`msg ${msg.role === 'cust' ? 'cust' : ''}`}>
                    <div className="msg-av">
                      {msg.role === 'cust' ? (chatWho.slice(0, 1) || '고') : 'AI'}
                    </div>
                    <div className="bubble">{msg.text}</div>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSendChat} style={{ marginTop: 14 }}>
              <div className="btn-row">
                <input
                  type="text"
                  className="input"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder={
                    chatEnded ? '종료된 대화입니다. 새 대화를 시작해 주세요.' : '채팅 메시지를 입력하세요...'
                  }
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={chatBusy || chatEnded}
                />
                <button
                  type="submit"
                  className="btn sm"
                  disabled={chatBusy || chatEnded || !chatInput.trim()}
                >
                  {chatBusy ? '전송 중...' : '전송'}
                </button>
              </div>
            </form>
          </div>

          {chatSummary && <SummaryCardBlock title="채팅 종료 요약 카드" card={chatSummary} />}
        </section>
      )}
    </Layout>
  );
};
