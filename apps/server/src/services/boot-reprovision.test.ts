import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb, type Db } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { servers } from '../db/schema/index.js'
import type { Logger } from '../logger.js'
import type { UnitProvisioner } from './unit-provision.js'
import { reprovisionAllUnits } from './boot-reprovision.js'

// The point of the boot pass is that it is total and non-fatal: every
// row gets re-rendered with its own overrides, and a single bad row is
// logged rather than thrown out of main().

let root: string
let db: Db
let closeDb: () => void

function makeProvisioner(): UnitProvisioner & { provision: ReturnType<typeof vi.fn> } {
  return { provision: vi.fn(async () => {}), deprovision: vi.fn(async () => {}) } as never
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as never
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-boot-reprov-'))
  const created = createDb(path.join(root, 'panel.sqlite'))
  db = created.db
  closeDb = () => created.sqlite.close()
  runMigrations(db)
  db.insert(servers)
    .values([
      {
        id: 'a',
        gameSlug: 'palworld',
        name: 'Pal',
        installDir: '/opt/games/palworld',
        unitName: 'palworld-server',
        memoryHigh: '12G',
        cpuQuotaPct: 200,
      },
      {
        id: 'b',
        gameSlug: 'enshrouded',
        name: 'Ensh',
        installDir: '/opt/games/enshrouded',
        unitName: 'enshrouded-server',
      },
    ])
    .run()
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('reprovisionAllUnits', () => {
  it('re-provisions every row, passing its stored overrides through', async () => {
    const provisioner = makeProvisioner()
    await reprovisionAllUnits(db, provisioner, makeLogger())

    expect(provisioner.provision).toHaveBeenCalledTimes(2)
    expect(provisioner.provision).toHaveBeenCalledWith('palworld', {
      memoryHigh: '12G',
      memoryMax: null,
      cpuQuotaPct: 200,
    })
    expect(provisioner.provision).toHaveBeenCalledWith('enshrouded', {
      memoryHigh: null,
      memoryMax: null,
      cpuQuotaPct: null,
    })
  })

  it('logs and continues when one row fails', async () => {
    const provisioner = makeProvisioner()
    provisioner.provision.mockRejectedValueOnce(new Error('systemctl blew up'))
    const logger = makeLogger()

    await expect(reprovisionAllUnits(db, provisioner, logger)).resolves.toBeUndefined()

    expect(provisioner.provision).toHaveBeenCalledTimes(2)
    expect(provisioner.provision).toHaveBeenLastCalledWith('enshrouded', expect.anything())
    expect(logger.warn).toHaveBeenCalledWith(
      'boot reprovision failed (continuing)',
      expect.objectContaining({ slug: 'palworld' }),
    )
  })
})
