import { describe, expect, it } from 'vitest';
import { END_LINE, beginLine } from './block';
import { reflectionHash } from './hash';
import { extractReflection, REFLECTION_PLACEHOLDER, reflectionBody, reflectionTemplate } from './reflection';

const B = `${beginLine('0123456789abcdef')}\n| 自動 | 產生 |\n${END_LINE}`;
const fm = '---\nwb_id: "trd_abcd1234"\ntitle: "## 反思"\n---\n';
const x = (s: string) => extractReflection(s);

describe('extractReflection', () => {
  it('a section running to the end of the file', () => {
    expect(x(`${fm}${B}\n\n## 反思\n\n第一段\n\n第二段\n\n`)).toEqual({ found: true, text: '第一段\n\n第二段', sections: 1 });
  });

  it('## stops at ## and #, not at ###', () => {
    expect(x('## 反思\na\n### 細節\nb\n## 下一段\nc').text).toBe('a\n### 細節\nb');
    expect(x('## 反思\na\n# 大標\nc').text).toBe('a');
    expect(x('### 反思\na\n#### 小\nb\n### 同級\nc').text).toBe('a\n#### 小\nb');
    expect(x('### 反思\na\n## 上一級\nc').text).toBe('a');
    expect(x('# 反思\na\n## 子\nb').text).toBe('a\n## 子\nb');
  });

  it('ignored inside a code fence, the wb block, a blockquote and the YAML', () => {
    expect(x(`${fm}${B}\n\`\`\`\n## 反思\nnot me\n\`\`\`\n`)).toEqual({ found: false, text: '', sections: 0 });
    expect(x(`${beginLine('0123456789abcdef')}\n## 反思\ngenerated\n${END_LINE}\n`)).toEqual({ found: false, text: '', sections: 0 });
    expect(x('> ## 反思\n> quoted')).toEqual({ found: false, text: '', sections: 0 });
    expect(x(`${fm}body`).found).toBe(false);
    expect(x('---\n## 反思\n---\nbody').found).toBe(false); // inside valid frontmatter
  });

  it('unclosed frontmatter counts as body', () => {
    expect(x('---\ntitle: x\n## 反思\n寫在這裡').text).toBe('寫在這裡');
  });

  it('fenced code inside the section belongs to it, headings in it do not end it', () => {
    expect(x('## 反思\n前\n```\n## 不是標題\n```\n後\n## 結束\n').text).toBe('前\n```\n## 不是標題\n```\n後');
  });

  it('two sections are concatenated', () => {
    const r = x(`## 反思\n一\n## 別的\n不算\n${B}\n## 反思\n二\n`);
    expect(r).toEqual({ found: true, text: '一\n\n二', sections: 2 });
  });

  it('placeholder only → found with empty text; no heading → not found', () => {
    expect(x(`${fm}${B}\n\n${reflectionTemplate()}`)).toEqual({ found: true, text: '', sections: 1 });
    expect(x(`## 反思\n\n  ${REFLECTION_PLACEHOLDER}  \n\n`)).toEqual({ found: true, text: '', sections: 1 });
    expect(x(`## 反思\n${REFLECTION_PLACEHOLDER}\n我的想法`).text).toBe('我的想法');
    expect(x('# 標題\n文字')).toEqual({ found: false, text: '', sections: 0 });
    expect(x('')).toEqual({ found: false, text: '', sections: 0 });
  });

  it('heading forms', () => {
    expect(x('##反思\na').found).toBe(false);
    expect(x('## 反思 \na').text).toBe('a');
    expect(x('## 反思 ##\na').text).toBe('a');
    expect(x('   ## 反思\na').text).toBe('a');
    expect(x('    ## 反思\na').found).toBe(false); // indented code
    expect(x('#### 反思\na').found).toBe(false);
    expect(x('## 反思與檢討\na').found).toBe(false);
  });

  it('the section stops at a wb marker, also when markers are invalid', () => {
    expect(x(`## 反思\n我的\n${B}\n之後`).text).toBe('我的');
    expect(x(`## 反思\n我的\n${END_LINE}\n之後`).text).toBe('我的');
    expect(x(`## 反思\n我的\n${beginLine('0123456789abcdef')}\n之後\n${beginLine('0123456789abcdef')}`).text).toBe('我的');
  });

  it('CRLF and NFD give the same text hash as LF and NFC', () => {
    const lf = x('## 反思\n café 想法\n').text;
    const crlf = x('﻿## 反思\r\n café 想法\r\n').text;
    expect(crlf).toBe(lf);
    expect(reflectionHash(crlf)).toBe(reflectionHash(lf));
  });
});

describe('reflectionBody (regression: a re-created note must read back as the stored text)', () => {
  const texts = [
    '進場太早。',
    '    縮排的程式碼\n第二行',
    'a\n\n## 子標題\nb',
    'a\n### 細節\nb',
    '```\n# 不是標題\n```\n之後',
    '- 清單\n  - 子清單',
  ];
  it.each(texts)('%j round-trips through a new note', (t) => {
    const file = `${fm}${B}\n\n${reflectionBody(t)}`;
    expect(x(file)).toEqual({ found: true, text: t, sections: 1 });
  });
  it('empty text is the plain template', () => {
    expect(reflectionBody('  \n')).toBe(reflectionTemplate());
  });
});
