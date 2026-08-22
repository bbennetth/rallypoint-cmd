import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DiskUsage } from '@rallypoint-cmd/shared'
import { dedupeDisks, dirSize } from './disk.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-disk-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('dirSize', () => {
  it('sums files across nested directories', async () => {
    fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(100))
    fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.alloc(25))
    fs.writeFileSync(path.join(root, 'sub', 'deeper', 'c.bin'), Buffer.alloc(7))

    expect(await dirSize(root)).toBe(132)
  })

  it('returns 0 for a missing directory', async () => {
    expect(await dirSize(path.join(root, 'nope'))).toBe(0)
  })

  it('returns 0 for an empty directory', async () => {
    expect(await dirSize(root)).toBe(0)
  })

  it('does not follow or count symlinks', async () => {
    fs.writeFileSync(path.join(root, 'real.bin'), Buffer.alloc(50))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-disk-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(10_000))
      fs.symlinkSync(path.join(outside, 'big.bin'), path.join(root, 'link.bin'))
      fs.symlinkSync(outside, path.join(root, 'linkdir'))

      expect(await dirSize(root)).toBe(50)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('dedupeDisks', () => {
  const disk = (label: string, totalBytes: number, freeBytes: number): DiskUsage => ({
    label,
    mount: `/mnt/${label}`,
    totalBytes,
    freeBytes,
  })

  it('collapses entries that report identical filesystem numbers', () => {
    const deduped = dedupeDisks([disk('games', 1000, 400), disk('backups', 1000, 400)])
    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.label).toBe('games')
  })

  it('keeps entries from distinct filesystems', () => {
    const deduped = dedupeDisks([disk('games', 1000, 400), disk('backups', 2000, 400)])
    expect(deduped).toHaveLength(2)
  })

  it('passes an empty list through', () => {
    expect(dedupeDisks([])).toEqual([])
  })
})
