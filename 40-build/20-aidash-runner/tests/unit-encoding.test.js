import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamTextDecoder, incompleteTailBytes } from '../src/stream-decoder.js';

/**
 * 输出解码回归测试。
 *
 * 现场缺陷：Windows cmd 按 GBK 输出「写个py」= D0 B4 B8 F6 70 79，
 * 旧实现用 StringDecoder('utf8') 解出 `'д��py'`，并把它写进日志和证据卡。
 */

const GBK_XIE_GE = Buffer.from([0xd0, 0xb4, 0xb8, 0xf6]); // 「写个」的 GBK 字节

test('GBK 输出：写个py 解码为中文而不是 д��py', () => {
  const decoder = new StreamTextDecoder();
  const text = decoder.write(Buffer.concat([GBK_XIE_GE, Buffer.from('py', 'ascii')])) + decoder.end();

  assert.equal(text, '写个py');
  assert.equal(text.includes('�'), false, '不应出现 U+FFFD 替换符');
  assert.equal(text.includes('д'), false, '不应被误解成西里尔字母 д');
  assert.equal(decoder.encoding, 'gbk');
});

test('GBK 输出被管道切在半个字符上也不误判：保留字节参与回退解码', () => {
  const decoder = new StreamTextDecoder();
  let text = '';
  // 第一块只有「写」的前导字节 D0：看起来像半个 UTF-8 字符，必须保留而不是报错。
  text += decoder.write(Buffer.from([0xd0]));
  // 第二块补齐 D0 B4 并带来 B8 F6；B8 不是合法 UTF-8 续字节，触发 GBK 回退。
  text += decoder.write(Buffer.from([0xb4, 0xb8, 0xf6]));
  text += decoder.end();

  assert.equal(text, '写个');
  assert.equal(decoder.encoding, 'gbk');
});

test('UTF-8 中文跨 chunk 不被误判成 GBK', () => {
  const decoder = new StreamTextDecoder();
  let text = '';
  // 「中」= E4 B8 AD，「文」= E6 96 87，故意切在字符中间。
  text += decoder.write(Buffer.from([0xe4]));
  text += decoder.write(Buffer.from([0xb8, 0xad, 0xe6]));
  text += decoder.write(Buffer.from([0x96, 0x87]));
  text += decoder.end();

  assert.equal(text, '中文');
  assert.equal(decoder.encoding, 'utf-8', '合法 UTF-8 不能被锁成 GBK');
  assert.equal(text.includes('�'), false);
});

test('UTF-8 与 ASCII 混合跨 chunk 保持原样', () => {
  const decoder = new StreamTextDecoder();
  let text = '';
  text += decoder.write(Buffer.from('hello ', 'ascii'));
  text += decoder.write(Buffer.from([0xe4, 0xb8])); // 「中」的前 2 字节
  text += decoder.write(Buffer.from([0xad]));
  text += decoder.write(Buffer.from('!', 'ascii'));
  text += decoder.end();

  assert.equal(text, 'hello 中!');
  assert.equal(decoder.encoding, 'utf-8');
});

test('incompleteTailBytes：只保留真正可能未收齐的末尾字节', () => {
  assert.equal(incompleteTailBytes(Buffer.alloc(0)), 0);
  assert.equal(incompleteTailBytes(Buffer.from('abc', 'ascii')), 0);
  assert.equal(incompleteTailBytes(Buffer.from([0xe4])), 1);
  assert.equal(incompleteTailBytes(Buffer.from([0xe4, 0xb8])), 2);
  assert.equal(incompleteTailBytes(Buffer.from([0xe4, 0xb8, 0xad])), 0);
  assert.equal(incompleteTailBytes(Buffer.from([0xf0, 0x9f, 0x98])), 3);
  assert.equal(incompleteTailBytes(Buffer.from([0x41, 0xe4])), 1);
  // 孤立续字节不是合法前缀，应交给严格解码报错（返回 0）。
  assert.equal(incompleteTailBytes(Buffer.from([0xb8])), 0);
  assert.equal(incompleteTailBytes(Buffer.from([0xe4, 0x41])), 0);
});
