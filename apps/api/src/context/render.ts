// MD 템플릿 렌더러 (mustache의 작은 부분집합): {{name}} 값, {{#name}}…{{/name}} 값이 있으면(배열이면 항목마다 반복), {{^name}}…{{/name}} 값이 없으면.
// 템플릿 원본은 templates/context/*.md. 사장님이 입력한 값은 이스케이프하지 않음 (MD 그대로 프롬프트에 들어감)
type Scope = Record<string, unknown>;
const SECTION = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const empty = (v: unknown) => v == null || v === false || v === '' || (Array.isArray(v) && v.length === 0);

function render(tpl: string, scopes: Scope[]): string {
  const lookup = (k: string) => { for (const s of scopes) if (k in s) return s[k]; return undefined; };
  const withSections = tpl.replace(SECTION, (_m, op: string, key: string, body: string) => {
    const v = lookup(key);
    if (op === '^') return empty(v) ? render(body, scopes) : '';
    if (empty(v)) return '';
    if (Array.isArray(v)) return v.map((item) => render(body, [typeof item === 'object' && item ? item as Scope : { '.': item }, ...scopes])).join('');
    return render(body, scopes);
  });
  return withSections.replace(/\{\{(\w+|\.)\}\}/g, (_m, key: string) => { const v = lookup(key); return empty(v) ? '' : String(v); });
}

/** 템플릿 + 값 → MD. 빈 줄이 3줄 이상 이어지면 2줄로 */
export function renderTemplateMd(tpl: string, values: Scope): string {
  return render(tpl, [values]).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
