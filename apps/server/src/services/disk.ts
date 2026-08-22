import fs from 'node:fs'
import path from 'node:path'
import type { DiskUsage } from '@rallypoint-cmd/shared'

// statfs-based disk usage for the panel's mounts. Also the pre-op
// free-space guard: refuse writes that would drop below the floor.

export async function diskUsage(label: string, dirPath: string): Promise<DiskUsage | null> {
  try {
    const s = await fs.promises.statfs(dirPath)
    return {
      label,
      mount: dirPath,
      totalBytes: s.blocks * s.bsize,
      freeBytes: s.bavail * s.bsize,
    }
  } catch {
    return null
  }
}

// Collapse duplicates when several dirs share one filesystem (statfs
// reports the mount, so two dirs on one disk return identical numbers).
export function dedupeDisks(disks: DiskUsage[]): DiskUsage[] {
  return disks.filter(
    (d, i) => disks.findIndex((o) => o.totalBytes === d.totalBytes && o.freeBytes === d.freeBytes) === i,
  )
}

// On-disk size of a directory tree. Tolerant of churn — entries that
// vanish mid-walk count as 0 and a missing root is an empty tree.
// Symlinks are neither followed nor sized (Dirent type checks are
// lstat-based), so a link can't double-count or escape the root.
export async function dirSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(abs)
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(abs)).size
      } catch {
        // vanished mid-walk
      }
    }
  }
  return total
}

// statfs the nearest existing ancestor — pre-install the target dir may
// not exist yet, but its filesystem does.
export async function freeBytes(dirPath: string): Promise<number> {
  let probe = dirPath
  for (;;) {
    try {
      const s = await fs.promises.statfs(probe)
      return s.bavail * s.bsize
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) throw new Error(`statfs failed for ${dirPath}`)
      probe = parent
    }
  }
}

export async function assertDiskFloor(
  dirPath: string,
  projectedWriteBytes: number,
  floorBytes: number,
): Promise<void> {
  const free = await freeBytes(dirPath)
  if (free - projectedWriteBytes < floorBytes) {
    const gib = (n: number): string => (n / 1024 ** 3).toFixed(1)
    throw new Error(
      `Not enough disk space: ${gib(free)} GiB free, operation needs ~${gib(projectedWriteBytes)} GiB while keeping a ${gib(floorBytes)} GiB floor`,
    )
  }
}
