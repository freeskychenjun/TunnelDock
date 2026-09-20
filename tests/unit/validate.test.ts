// 纯函数单测：地址归一化 / HOST_RE / PIN 生成 / Quick Tunnel URL 正则
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { genPin, normalizeHost, HOST_RE, QUICK_URL_RE } from '../../src/main/validate.ts'

test('normalizeHost：剥协议头 / 路径 / 端口 / 空白，转小写', () => {
  assert.equal(normalizeHost('http://172.14.60.197/'), '172.14.60.197')
  assert.equal(normalizeHost('  https://My.Host.example:8080/some/path '), 'my.host.example')
  assert.equal(normalizeHost('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeHost(''), '')
})

test('HOST_RE：主机名或 IPv4', () => {
  assert.ok(HOST_RE.test('127.0.0.1'))
  assert.ok(HOST_RE.test('a.b-c.example'))
  assert.ok(!HOST_RE.test('bad host'))
  assert.ok(!HOST_RE.test('http://x'))
  assert.ok(!HOST_RE.test('-leading'))
})

test('genPin：8 位数字', () => {
  const pin = genPin()
  assert.match(pin, /^\d{8}$/)
  assert.ok(Number(pin) >= 10000000 && Number(pin) < 100000000)
})

test('QUICK_URL_RE：匹配多词子域，排除 api.trycloudflare.com', () => {
  const m = '2026-01-01 INF +--------------------------------------------------------------------------------------------+\n2026-01-01 INF |  https://dominant-instruction-enb-lime.trycloudflare.com                                                   |\n'.match(QUICK_URL_RE)
  assert.equal(m?.[0], 'https://dominant-instruction-enb-lime.trycloudflare.com')
  // 单词子域是 Cloudflare 自家 API 端点（会出现在日志里），绝不能当隧道地址
  assert.equal('api.trycloudflare.com'.match(QUICK_URL_RE), null)
  assert.equal('https://api.trycloudflare.com/client/v4'.match(QUICK_URL_RE), null)
})
