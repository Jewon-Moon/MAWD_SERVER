// 서버 음성 합성 (선택: OpenAI gpt-4o-mini-tts). 라이너에는 TTS가 없으므로 TTS_API_KEY(또는 OpenAI LLM_API_KEY)가 있을 때만 동작하고, 없으면 Vapi 또는 브라우저 음성으로 대체합니다.
import { PassThrough, Readable } from 'node:stream';
import OpenAI from 'openai';
import { ApiError } from '../errors.js';

export type TtsOpts = { voice: string; speed: number; instructions: string };
/** wav 스트림. 받는 대로 흘려보냄. 측정: 첫 오디오 wav 0.7~0.8초 / mp3 0.9~1.8초, 전체 생성을 기다리면 1.3~2초 */
export type Tts = ((text: string, o: TtsOpts) => Promise<Readable>) & { configured?: boolean };

export function createTts(env = process.env): Tts {
  const llmIsOpenAi = (env.LLM_BASE_URL?.trim() || '').includes('openai.com');
  const apiKey = env.TTS_API_KEY?.trim() || (llmIsOpenAi && !env.LINER_API_KEY?.trim() ? env.LLM_API_KEY?.trim() : '') || '';
  const client = apiKey
    ? new OpenAI({ baseURL: env.TTS_BASE_URL?.trim() || 'https://api.openai.com/v1', apiKey, maxRetries: 1, timeout: 15_000 })
    : null;
  // 같은 문장 · 목소리면 재사용 (인사 · 본인 확인 요청 같은 고정 문구는 두 번째부터 즉시)
  // shortcut: 프로세스 메모리, 300개 넘으면 오래된 것부터 버림. 서버 여러 대면 오브젝트 스토리지로
  const cache = new Map<string, Promise<Buffer>>();
  const speak = async (text: string, o: TtsOpts): Promise<Readable> => {
    if (!client) throw new ApiError(409, 'tts_not_configured', '서버 음성 합성 키(TTS_API_KEY)가 없어 브라우저 음성으로 대체합니다.');
    const key = JSON.stringify([text, o.voice, o.speed, o.instructions]);
    const hit = cache.get(key);
    if (hit) return Readable.from([await hit]);
    const res = await client.audio.speech.create({ model: env.TTS_MODEL || 'gpt-4o-mini-tts', voice: o.voice, input: text, instructions: o.instructions || undefined, speed: o.speed, response_format: 'wav' });
    const src = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    const full = new Promise<Buffer>((ok, fail) => {
      src.on('data', (c: Buffer) => chunks.push(c)).on('end', () => ok(Buffer.concat(chunks))).on('error', fail);
    });
    full.catch(() => cache.delete(key));
    cache.set(key, full);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    src.pipe(out);
    return out;
  };
  return Object.assign(speak, { configured: !!client });
}
