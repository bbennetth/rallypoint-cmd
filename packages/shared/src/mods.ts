import { z } from 'zod'

// Server-side .pak mods live under the install dir's Pal/Content/Paks/~mods (UE
// mounts every pak in that dir); disabled mods are parked in the sibling
// ~mods-disabled dir. The filesystem is the source of truth — a "mod" is
// a pak filename stem plus optional same-stem UE5 sidecars
// (.ucas/.utoc/.sig), and its id is that stem.

// Filename allowlist shared by upload validation and the zip-entry
// filter: no path separators, no leading dot, conservative charset.
export const SAFE_MOD_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ ()[\]-]{0,199}\.(pak|ucas|utoc|sig)$/

export const modFileSchema = z.object({
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
})
export type ModFile = z.infer<typeof modFileSchema>

export const modSchema = z.object({
  id: z.string(), // pak filename stem, e.g. "MyMod_P"
  pakFilename: z.string(),
  files: z.array(modFileSchema), // the pak + any sidecars
  sizeBytes: z.number().int().nonnegative(), // sum over files
  modifiedAtMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
})
export type Mod = z.infer<typeof modSchema>

export const modsResponseSchema = z.object({
  mods: z.array(modSchema),
})
export type ModsResponse = z.infer<typeof modsResponseSchema>

// Upload response: which pak stems were installed, plus the fresh list.
export const modUploadResultSchema = z.object({
  installed: z.array(z.string()),
  mods: z.array(modSchema),
})
export type ModUploadResult = z.infer<typeof modUploadResultSchema>

export const modToggleRequestSchema = z.object({
  enabled: z.boolean(),
})
export type ModToggleRequest = z.infer<typeof modToggleRequestSchema>
