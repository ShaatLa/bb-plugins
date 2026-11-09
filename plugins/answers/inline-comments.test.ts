import { expect, it } from 'vitest';
import { parseInlineComments } from './inline-comments';
const block = (label: string, passage: string, comment: string) => `Context for @${label} (resolved by plugin "inline-comments"):\n\nThe user attached this passage from the conversation to their message:\n\n> ${passage}\n\nTheir comment on it: ${comment}`;
it('parses the supplied sample', () => { const label='Отдельно и с аудитом разблокироват…'; expect(parseInlineComments(`@${label}\n${block(label,'Отдельно и с аудитом разблокировать маршрут. Само закрытие попыток маршрут не откроет.','Как это сделать?')}`)).toEqual({text:'',comments:[{label,passage:'Отдельно и с аудитом разблокировать маршрут. Само закрытие попыток маршрут не откроет.',comment:'Как это сделать?'}]}); });
// The plugin appends its blocks after the owner's text, one after another.
it('keeps owner text before two appended blocks', () => expect(parseInlineComments(`Before @one and @two\n${block('one','First','Why?')}\n${block('two','Second','How?')}`)).toEqual({text:'Before  and',comments:[{label:'one',passage:'First',comment:'Why?'},{label:'two',passage:'Second',comment:'How?'}]}));
it('leaves plain text unchanged', () => expect(parseInlineComments('  plain text  ')).toEqual({text:'  plain text  ',comments:[]}));
it('accepts missing passage and comment', () => expect(parseInlineComments('@x\nContext for @x (resolved by plugin "inline-comments"):\nThe user attached this passage from the conversation to their message:')).toEqual({text:'',comments:[{label:'x',passage:'',comment:''}]}));
it('keeps a multi-line comment whole', () => {
  const text = '@Pass…\nContext for @Pass… (resolved by plugin "inline-comments"):\n\nThe user attached this passage from the conversation to their message:\n\n> Passage\n\nTheir comment on it: First line\nsecond line';
  expect(parseInlineComments(text)).toEqual({ text: '', comments: [{ label: 'Pass…', passage: 'Passage', comment: 'First line\nsecond line' }] });
});
