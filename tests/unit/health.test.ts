// judgeProbe 纯函数单测：隧道死活判定的边界（530 / Worker 离线文案 / 源站 5xx / 不可观测）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeProbe } from '../../src/main/health.ts'

test('alive：HTTP <500（PIN 墙、源站正常响应都算隧道层是通的）', () => {
  assert.equal(judgeProbe(200, '安全入口'), 'alive')
  assert.equal(judgeProbe(302, ''), 'alive')
  assert.equal(judgeProbe(401, 'Unauthorized'), 'alive')
  assert.equal(judgeProbe(404, 'not found'), 'alive')
  assert.equal(judgeProbe(429, 'too many'), 'alive')
})

test('down：530 = CF 1033 命名隧道无活跃连接器', () => {
  assert.equal(judgeProbe(530, '<html>error 1033</html>'), 'down')
})

test('down：Worker 在 agent 离线时的固定文案（wss 模式）', () => {
  assert.equal(judgeProbe(502, '解密平台 隧道离线：桌面端未连接'), 'down')
  assert.equal(judgeProbe(504, '隧道请求超时: agent response timeout'), 'down')
})

test('alive：其余 5xx 是源站自身的问题，不算隧道的账', () => {
  assert.equal(judgeProbe(500, 'Internal Server Error'), 'alive')
  assert.equal(judgeProbe(502, 'Bad Gateway（源站返回）'), 'alive')
  assert.equal(judgeProbe(503, 'Service Unavailable'), 'alive')
})

test('unknown：status=null = 本机连不上 CF 边缘，无法观测', () => {
  assert.equal(judgeProbe(null, ''), 'unknown')
})
