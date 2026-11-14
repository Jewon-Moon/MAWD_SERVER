// 스트리밍 텍스트를 문장 단위로 끊습니다. 첫 문장이 끝나는 즉시 TTS를 시작하기 위함 (F9 속도 예산).

const END = /([.?!。…~]+["')\]]*)(\s+|$)|\n+/g;

export class SentenceSplitter {
  private buf = '';

  /** 조각을 넣으면 완성된 문장들을 돌려줍니다 */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let last = 0;
    for (const m of this.buf.matchAll(END)) {
      const end = m.index + m[0].length;
      // 버퍼 끝에서 끝난 구두점은 다음 조각에 숫자 등이 이어질 수 있어(예: "3." + "5만원") 확정하지 않음
      if (end === this.buf.length && !m[0].includes('\n') && !/\s$/.test(m[0])) break;
      const s = this.buf.slice(last, end).trim();
      if (s) out.push(s);
      last = end;
    }
    this.buf = this.buf.slice(last);
    return out;
  }

  /** 스트림이 끝났을 때 남은 문장 */
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = '';
    return s ? [s] : [];
  }
}
