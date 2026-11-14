import { test, assert } from 'vitest'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
// These published fixtures encode Linux/macOS CBC, independently of the test host.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
let decryptChromeBlob: typeof import('../src/chrome.ts')['decryptChromeBlob']
try {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  ;({ decryptChromeBlob } = await import('../src/chrome.ts'))
} finally { Object.defineProperty(process, 'platform', platformDescriptor) }

test('chrome: decryptChromeBlob matches the reference AES-128-CBC scheme', () => {
  // Encode a password the way Chrome macOS does: PBKDF2(safe, saltysalt, 1003, 16) key,
  // AES-128-CBC with IV = 0x20 * 16, 'v10' prefix, PKCS7 padding.
  const safe = 'Ceq3uF+05s+hSD2wpGjnnQ=='
  const key = pbkdf2Sync(safe, 'saltysalt', 1003, 16, 'sha1')
  const iv = Buffer.alloc(16, 0x20)
  const plaintext = Buffer.from('hunter2-secret')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), ct])
  assert.equal(decryptChromeBlob(blob, key), 'hunter2-secret')
  // Non-v10 blob returns ''.
  assert.equal(decryptChromeBlob(Buffer.from('abc'), key), '')
})

test('chrome: decrypt scheme round-trips with the reference CBC parameters', () => {
  const { pbkdf2Sync, createCipheriv } = require('node:crypto')
  const key = pbkdf2Sync('Ceq3uF+05s+hSD2wpGjnnQ==', 'saltysalt', 1003, 16, 'sha1')
  const iv = Buffer.alloc(16, 0x20)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from('roundtrip-pw')), cipher.final()])
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), ct])
  assert.equal(decryptChromeBlob(blob, key), 'roundtrip-pw')
})

test('chrome: Linux v10 decrypts with the fixed "peanuts" key', () => {
  const key = pbkdf2Sync(Buffer.from('peanuts'), 'saltysalt', 1, 16, 'sha1')
  const iv = Buffer.alloc(16, 0x20)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from('linux-pass-1')), cipher.final()])
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), ct])
  assert.equal(decryptChromeBlob(blob, key), 'linux-pass-1')
})
