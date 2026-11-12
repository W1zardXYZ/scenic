import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

process.env.SCENIC_DATA = mkdtempSync(join(tmpdir(), 'scenic-ai-'))
const { db } = await import('./db.ts')
const { thumbPath } = await import('./scan.ts')
const ai = await import('./ai.ts')

test('replies are read through code fences and chatter, and cleaned', () => {
  const reply = 'Sure!\n```json\n{"description": "  A ruined  tavern by a river. ", "tags": ["Tavern", "tavern", "River", 3, "  Ruins "]}\n```'
  assert.deepEqual(ai.parseReply(reply), { description: 'A ruined tavern by a river.', tags: ['Tavern', 'River', 'Ruins'] })
  assert.deepEqual(ai.parseReply([{ type: 'text', text: '{"description":"Camp","tags":[]}' }]), { description: 'Camp', tags: ['Town'] })
  // A plain answer becomes the description, with its terrain words as tags.
  assert.deepEqual(ai.parseReply('A forest clearing with fallen trees and a hole. Also a path.'), { description: 'A forest clearing with fallen trees and a hole.', tags: ['Forest'] })
  assert.equal(ai.parseReply(''), null)
  assert.equal(ai.parseReply('This is a top-down battle map for a tabletop roleplaying game.'), null, 'an echo of the prompt is no answer')
  assert.equal(ai.parseReply('{broken json'), null)
  assert.equal(ai.parseReply('{"description": "", "tags": []}'), null)
  assert.equal(ai.parseReply('{"tags": ["x"]}'), null)
})

test('servers on this network keep thumbnails home', () => {
  for (const url of ['http://localhost:1234/v1', 'http://192.168.1.20:11434/v1', 'http://my-mac.local:1234/v1', 'http://studio:1234/v1', 'http://[::1]:1234/v1']) {
    assert.equal(ai.leavesNetwork(url), false, url)
  }
  assert.equal(ai.leavesNetwork('https://openrouter.ai/api/v1'), true)
  assert.equal(ai.leavesNetwork('not a url'), true)
})

/** A stand-in for an OpenAI-compatible API that records what it was sent. */
async function fakeApi(answer: (req: IncomingMessage, body: string) => [number, unknown]) {
  const seen: { url: string; auth: string; body: string }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body })
      const [status, json] = answer(req, body)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() }
}

function addScene(id: number, title: string, hidden = false) {
  db.prepare('INSERT OR IGNORE INTO root (id, path) VALUES (1, ?)').run('/maps')
  db.prepare('INSERT INTO grp (id, title, creator, pack, cover_id) VALUES (?, ?, ?, ?, ?)').run(id, title, '', '', id)
  db.prepare(`INSERT INTO file (id, root_id, path, kind, bytes, mtime, rel, name, status, group_id, variant_kind) VALUES (?, 1, ?, 'image', ?, 0, ?, ?, 'ok', ?, 'lighting')`)
    .run(id, `/maps/${title}.jpg`, 1000 + id, `maps/${title}.jpg`, title, id)
  if (hidden) db.prepare('INSERT INTO edit (key, data) VALUES (?, ?)').run(`${1000 + id}:${title}`, JSON.stringify({ hidden: true }))
}

test('a run sends only the cover thumbnail and stores what comes back', async () => {
  addScene(1, 'Gloomhollow Inn')
  addScene(2, 'Secret Lair', true)
  addScene(3, 'No Thumbnail')
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#557744' } }).webp().toFile(thumbPath(1, 'small'))

  const api = await fakeApi((req) => req.url === '/v1/models'
    ? [200, { data: [{ id: 'vision-model', name: 'Vision', pricing: { prompt: '0.000001', completion: '0.000002', image: '0.001' }, architecture: { input_modalities: ['text', 'image'] } }] }]
    : [200, { choices: [{ message: { content: '{"description": "A cosy tavern.", "tags": ["Tavern", "Town"]}' } }] }])
  try {
    ai.saveAiSettings({ enabled: true, baseUrl: `${api.url}/`, model: 'vision-model', apiKey: 'secret' })
    assert.equal(ai.aiSettings().hasKey, true)
    assert.equal('apiKey' in ai.aiSettings(), false)

    const before = await ai.aiStatus()
    assert.equal(before.waiting, 2, 'the hidden scene is not queued')
    assert.equal(before.leavesNetwork, false)
    assert.equal(before.estimate, 0, 'a server on this network costs nothing')

    await ai.startAi()
    const calls = api.seen.filter((c) => c.url === '/v1/chat/completions')
    assert.equal(calls.length, 1, 'a scene without a thumbnail is not sent')
    assert.equal(calls[0].auth, 'Bearer secret')
    const sent = JSON.parse(calls[0].body)
    assert.equal(sent.model, 'vision-model')
    assert.match(sent.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/)
    assert.doesNotMatch(calls[0].body, /Gloomhollow/, 'names are not sent')

    assert.deepEqual(ai.sceneSuggestions().get(1), { description: 'A cosy tavern.', tags: ['Tavern', 'Town'] })
    const after = await ai.aiStatus()
    assert.equal(after.described, 1)
    assert.equal(after.waiting, 1, 'the scene without a thumbnail waits for another try')
  } finally {
    api.close()
  }
})

test('a refused request stops the run and leaves scenes waiting', async () => {
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#335577' } }).webp().toFile(thumbPath(3, 'small'))
  const api = await fakeApi(() => [401, { error: { message: 'No auth credentials found' } }])
  try {
    ai.saveAiSettings({ baseUrl: api.url, apiKey: null })
    await ai.startAi()
    const status = await ai.aiStatus()
    assert.match(status.error, /401: No auth credentials found/)
    assert.equal(status.waiting, 1)
    assert.equal(status.running, false)
  } finally {
    api.close()
  }
})

test('prices come from the provider, per waiting scene', async () => {
  const models = [{ id: 'm', name: 'M', pricing: { prompt: '0.000001', completion: '0.000002', image: '0.001' } }]
  const api = await fakeApi(() => [200, { data: models }])
  try {
    const [m] = await ai.listModels(api.url, '')
    // 1050 prompt tokens, 150 reply tokens and one image.
    assert.ok(Math.abs(m.perScene! - (0.00105 + 0.0003 + 0.001)) < 1e-9)
  } finally {
    api.close()
  }
})
