import type {parseMode, parseStrategy, parseStrength} from './options.ts'
import type {InputOptions} from 'rolldown'

export type Mode = NonNullable<ReturnType<typeof parseMode>>
export type DeclarationStrategy = NonNullable<ReturnType<typeof parseStrategy>>
export type TerserStrength = NonNullable<ReturnType<typeof parseStrength>>

export interface BundilOptions {
  arch?: string
  bundle?: boolean
  bunExclusive?: boolean
  copyFiles?: ReadonlyArray<string> | string
  define?: Record<string, string>
  dtsFileName?: string
  dtsStrategy?: DeclarationStrategy
  emitDts?: 'auto' | boolean
  inputFileName?: string
  laxVersions?: boolean
  mode?: Mode
  optimizeCopiedScripts?: boolean
  outputFolder?: string
  platform?: string
  plugins?: InputOptions['plugins']
  precompiled?: boolean
  runtimeEntryFile?: string
  target?: string
  terserStrength?: TerserStrength
}

export interface BundilResult {
  declarationStrategy?: Exclude<DeclarationStrategy, 'auto'>
  files: Array<string>
  outputFolder: string
}

export type ExportTarget = Array<ExportTarget> | {[condition: string]: ExportTarget} | string | null
export type ExportMap = Record<string, ExportTarget>
export type Dependencies = Record<string, string>
export interface Manifest extends Record<string, unknown> {
  bin?: Record<string, string> | string
  dependencies?: Dependencies
  devDependencies?: Dependencies
  exports?: ExportTarget
  name: string
  optionalDependencies?: Dependencies
  peerDependencies?: Dependencies
  types?: string
  version: string
}
