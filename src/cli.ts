#!/usr/bin/env bun

import {parseArgs} from 'node:util'

import metadata from '../package.json' with {type: 'json'}
import {parseMode, parseStrategy, parseStrength} from './lib/options.ts'

const flags = {
  help: {
    type: 'boolean',
    short: 'h',
  },
  version: {
    type: 'boolean',
    short: 'V',
  },
  verbose: {
    type: 'boolean',
    short: 'v',
  },
  target: {type: 'string'},
  mode: {type: 'string'},
  bundle: {type: 'boolean'},
  outputFolder: {type: 'string'},
  inputFileName: {type: 'string'},
  runtimeEntryFile: {type: 'string'},
  emitDts: {type: 'boolean'},
  dtsStrategy: {type: 'string'},
  dtsFileName: {type: 'string'},
  terserStrength: {type: 'string'},
  laxVersions: {type: 'boolean'},
  precompiled: {type: 'boolean'},
  copyFiles: {
    type: 'string',
    multiple: true,
  },
  optimizeCopiedScripts: {type: 'boolean'},
  bunExclusive: {type: 'boolean'},
  arch: {type: 'string'},
  platform: {type: 'string'},
} as const
const help = `bundil [target] [options]

Pack a directory, package.json or source entry as dist/<name>/<mode>.

  --mode <production|development>                default: production unless NODE_ENV=development
  --output-folder <path>                         base directory, relative to target (default: dist)
  --bundle                                       bundle regular dependencies
  --terser-strength <auto|true|false|aggressive|max>
  --[no-]emit-dts                                default: enabled in production
  --dts-strategy <auto|bundle|preserve>           default: bundle with a preserve fallback
  --dts-file-name <file>                         bundled root declarations (default: lib.d.ts)
  --input-file-name <file>                       fallback entry under src/ (default: main.ts)
  --runtime-entry-file <path>                    override the root JavaScript input
  --precompiled                                  keep the runtime entry at its original location
  --copy-files <path>                            include a file or directory (repeatable)
  --optimize-copied-scripts                      also minify copied JavaScript
  --no-lax-versions                              keep exact dependency versions
  --bun-exclusive                                resolve Bun exports and disable Deno branches
  --platform <name|native>  --arch <name|native> specialize runtime platform or architecture
  -v, --verbose                                  list package files
  -V, --version                                  print bundil’s version
  -h, --help                                     show this help

Long options accept both kebab-case and camelCase.`
const normalizeFlag = (argument: string) => {
  const match = /^--(no-)?([\w-]+)(=.*)?$/u.exec(argument)
  if (!match) {
    return argument
  }
  const [, negative = '', key, value = ''] = match
  const name = key.replaceAll(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
  if (name === 'terserStrength' && negative) {
    return '--terserStrength=false'
  }
  if (Object.hasOwn(flags, name) && flags[name as keyof typeof flags].type === 'boolean' && !negative && (value === '=true' || value === '=false')) {
    return `--${value === '=false' ? 'no-' : ''}${name}`
  }
  return `--${negative}${name}${value}`
}
const run = async () => {
  const args = process.argv.slice(2)
  const end = args.indexOf('--')
  const {values, positionals} = parseArgs({
    args: args.map((arg, i) => (end === -1 || i < end ? normalizeFlag(arg) : arg)),
    options: flags,
    allowNegative: true,
    allowPositionals: true,
  })
  const {help: showHelp, version, verbose, mode, dtsStrategy, terserStrength, target, ...options} = values
  if (showHelp || version) {
    console.log(showHelp ? help : metadata.version)
    return
  }
  if (positionals.length > (target ? 0 : 1)) {
    throw new Error('Expected one package target. See bundil --help.')
  }
  const {bundil} = await import('./main.ts')
  const result = await bundil({
    ...options,
    target: target ?? positionals[0],
    mode: parseMode(mode),
    dtsStrategy: parseStrategy(dtsStrategy),
    terserStrength: parseStrength(terserStrength === 'false' ? false : (terserStrength === 'true' ? true : terserStrength)),
  })
  console.log(result.outputFolder)
  if (verbose) {
    console.log(result.files.join('\n'))
  }
}
try {
  await run()
} catch (error) {
  console.error(Error.isError(error) ? error.message : error)
  process.exitCode = 1
}
