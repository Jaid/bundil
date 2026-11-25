import type {writeDeclarations} from './declarations.ts'
import type {Project} from './project.ts'
import type {Dependencies, ExportMap} from './types.ts'

import {join} from 'node:path'

import valid from 'semver/functions/valid.js'

import {inside, relativePath} from './paths.ts'

const metadata = ['name', 'version', 'description', 'keywords', 'author', 'contributors', 'maintainers', 'license', 'licenses', 'repository', 'homepage', 'bugs', 'funding', 'engines', 'os', 'cpu', 'libc', 'sideEffects', 'deprecated', 'publishConfig', 'private', 'peerDependenciesMeta'] as const

export const writeManifest = async (project: Project, destination: string, declarations?: Awaited<ReturnType<typeof writeDeclarations>>) => {
  const {manifest, options, entries, bins} = project
  const output: Record<string, unknown> = Object.fromEntries(metadata.filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]))
  output.type = 'module'
  const packageExports: ExportMap = {}
  for (const [key, entry] of entries) {
    const runtime = `./${entry.output}`
    const typesPath = declarations?.paths.get(key) ?? (options.precompiled && /\.d\.[cm]?ts$/u.test(entry.types) ? relativePath(project.root, entry.types) : undefined)
    const types = typesPath && `./${typesPath}`
    packageExports[key] = {
      ...types ? {types} : {},
      ...entry.source ? {import: runtime, default: runtime} : {},
    }
    if (key === '.' && types) {
      output.types = types
    }
  }
  Object.assign(packageExports, project.passthrough)
  if (Object.keys(packageExports).length) {
    output.exports = packageExports
  }
  if (bins.size) {
    output.bin = typeof manifest.bin === 'string' ? './cli.js' : Object.fromEntries([...bins].map(([name, entry]) => [name, `./${entry.output}`]))
  }
  const dependencies: Dependencies = options.bundle ? {} : {...manifest.dependencies}
  for (const name of declarations?.imports ?? []) {
    const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
    if (version && !Object.hasOwn(manifest.peerDependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name)) {
      dependencies[name] = version
    }
  }
  for (const [field, versions] of Object.entries({
    dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  })) {
    if (versions && Object.keys(versions).length) {
      output[field] = Object.fromEntries(Object.entries(versions).map(([name, version]) => [name, options.laxVersions !== false && valid(version) ? `^${version}` : version]))
    }
  }
  if (!project.production) {
    output.private = true
  } else if (!output.license && !output.licenses) {
    output.license = 'MIT'
  }
  await Bun.write(join(destination, 'package.json'), `${JSON.stringify(output)}\n`)
  const checkTarget = async (value: unknown): Promise<void> => {
    if (typeof value === 'string') {
      const file = inside(destination, value)
      if (!value.startsWith('./') || !value.includes('*') && !await Bun.file(file).exists()) {
        throw new Error(`Missing or invalid package export: ${value}. Include precompiled files with copyFiles.`)
      }
    } else if (value && typeof value === 'object') {
      await Promise.all(Object.values(value).map(checkTarget))
    }
  }
  await checkTarget(packageExports)
}
