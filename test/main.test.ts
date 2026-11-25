import type {Manifest} from '#src/lib/types.ts'

import {afterEach, beforeEach, expect, test} from 'bun:test'
import {rejects} from 'node:assert/strict'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import fs from 'fs-extra'
import ts from 'typescript'

import bundil from '#src/main.ts'

let workspace: string
let root: string
let consumer: string
const cli = resolve(import.meta.dir, '../src/cli.ts')
beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), 'bundil-test-'))
  root = join(workspace, 'project')
  consumer = join(workspace, 'consumer')
  await fs.outputJson(join(consumer, 'package.json'), {type: 'module'})
})
afterEach(async () => fs.remove(workspace))
const fixture = async (manifest: Record<string, unknown>, files: Record<string, string>) => {
  await fs.outputJson(join(root, 'package.json'), {
    name: 'fixture',
    version: '1.2.3',
    type: 'module',
    ...manifest,
  })
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(root, name), content)
  }
}
const run = async (cwd: string, args: Array<string>) => {
  const result = await Bun.$`${process.execPath} ${args}`.cwd(cwd).quiet()
  return result.stdout.toString().trim()
}
const readManifest = async (folder: string) => await Bun.file(join(folder, 'package.json')).json() as Manifest
const install = async (folder: string) => {
  const manifest = await readManifest(folder)
  const installed = join(consumer, 'node_modules', manifest.name)
  await fs.copy(folder, installed)
  return installed
}
const typecheck = async (source: string) => {
  const file = join(consumer, 'index.ts')
  await Bun.write(file, source)
  for (const module of [ts.ModuleKind.NodeNext, ts.ModuleKind.Preserve]) {
    const program = ts.createProgram([file], {
      module,
      target: ts.ScriptTarget.ESNext,
      strict: true,
      noEmit: true,
      types: [],
    })
    const errors = ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    expect(errors).toEqual([])
  }
}
test('packs a scoped ESM library, subpath and executable for an isolated consumer', async () => {
  await fixture({
    name: '@scope/greet',
    exports: {
      '.': {import: './lib/index.tsx'},
      './again': './lib/again.ts',
    },
    bin: './commands/greet.ts',
    imports: {'#lib/*': './lib/*'},
    scripts: {build: 'bundil'},
    files: ['lib'],
    sideEffects: false,
  }, {
    'lib/index.tsx': 'import style from \'./style.css\' with {type: \'text\'}\nimport {greet} from \'#lib/greet.ts\'\nexport {greet as default}\nexport const text: string = style\nexport type {Greeting} from \'#lib/greet.ts\'',
    'lib/greet.ts': 'export type Greeting = {name: string}; export const greet = ({name}: Greeting) => `Hello ${name}!`',
    'lib/again.ts': 'export {greet as again} from \'#lib/greet.ts\'',
    'lib/style.css': 'body { color: red }',
    'commands/greet.ts': '#!/usr/bin/env bun\nimport greet from \'../lib/index.tsx\'\nconsole.log(greet({name: \'CLI\'}))',
    'readme.md': '# Greet',
    'license.txt': 'Test license',
  })
  const {outputFolder, files} = await bundil({
    target: join(root, 'package.json'),
    mode: 'production',
    dtsFileName: 'declarations/main.d.ts',
  })
  expect(outputFolder).toEndWith('/dist/@scope/greet/production')
  expect(files).toContain('declarations/main.d.ts')
  const installed = await install(outputFolder)
  const pkg = await readManifest(installed)
  expect(pkg.exports).toMatchObject({'.': {
    types: './declarations/main.d.ts',
    import: './lib.js',
    default: './lib.js',
  }})
  expect(pkg.bin).toBe('./cli.js')
  expect(pkg.sideEffects).toBe(false)
  for (const field of ['files', 'imports', 'scripts', 'devDependencies', 'private']) {
    expect(pkg).not.toHaveProperty(field)
  }
  expect(await Bun.file(join(installed, 'README.md')).text()).toBe('# Greet')
  expect(await Bun.file(join(installed, 'LICENSE')).text()).toBe('Test license')
  expect(await Bun.file(join(installed, 'cli.js')).text()).toStartWith('#!/usr/bin/env bun\n')
  if (process.platform !== 'win32') {
    const stats = await fs.stat(join(installed, 'cli.js'))
    expect(stats.mode & 0o111).toBe(0o111)
  }
  expect(await run(consumer, [join(installed, 'cli.js')])).toBe('Hello CLI!')
  expect(await run(consumer, ['-e', 'import greet, {text} from \'@scope/greet\'; import {again} from \'@scope/greet/again\'; console.log(greet === again, text)'])).toBe('true body { color: red }')
  await typecheck('import greet, {type Greeting} from \'@scope/greet\'; import {again} from \'@scope/greet/again\'; const who: Greeting = {name: \'consumer\'}; const message: string = again(who) + greet(who);')
}, 30_000)
test('matches dependency subpaths and bundles only regular dependencies on request', async () => {
  await fixture({
    dependencies: {'@scope/value': '1.0.0'},
    optionalDependencies: {optional: '2.0.0-beta.1'},
    peerDependencies: {peer: '~1.2.0'},
  }, {
    'src/main.ts': 'import a from \'@scope/value/sub\'; import b from \'optional/sub\'; import c from \'peer\'; export default a + b + c',
    'node_modules/@scope/value/package.json': JSON.stringify({
      name: '@scope/value',
      type: 'module',
      exports: {'./sub': './sub.js'},
    }),
    'node_modules/@scope/value/sub.js': 'export default 1',
    'src/cli.ts': 'import n from \'./main.ts\'; console.log(n)',
  })
  for (const [name, file, value] of [['optional', 'sub', 2], ['peer', 'main', 4]] as const) {
    const folder = join(consumer, 'node_modules', name)
    await fs.outputJson(join(folder, 'package.json'), {
      type: 'module',
      exports: name === 'peer' ? './main.js' : {'./sub': './sub.js'},
    })
    await Bun.write(join(folder, `${file}.js`), `export default ${value}`)
  }
  const external = await bundil({
    target: root,
    mode: 'development',
  })
  const manifest = await readManifest(external.outputFolder)
  expect(manifest).toMatchObject({
    private: true,
    dependencies: {'@scope/value': '^1.0.0'},
    optionalDependencies: {optional: '^2.0.0-beta.1'},
    peerDependencies: {peer: '~1.2.0'},
    bin: {fixture: './cli.js'},
  })
  expect(manifest).not.toHaveProperty('types')
  expect(await Bun.file(join(external.outputFolder, 'lib.js')).text()).toContain('@scope/value/sub')
  const bundled = await bundil({
    target: root,
    mode: 'production',
    bundle: true,
    emitDts: false,
    laxVersions: false,
  })
  const installed = await install(bundled.outputFolder)
  const bundledManifest = await readManifest(installed)
  expect(bundledManifest).not.toHaveProperty('dependencies')
  expect(bundledManifest.optionalDependencies?.optional).toBe('2.0.0-beta.1')
  expect(bundledManifest.peerDependencies?.peer).toBe('~1.2.0')
  expect(await run(consumer, [join(installed, 'cli.js')])).toBe('7')
}, 30_000)
test('publishes usable merged-namespace declarations and preserves literal types when rewriting aliases', async () => {
  await fixture({imports: {'#src/*': './src/*'}}, {
    'src/types.ts': 'export type Value<T> = {value: T}; export type Literal = \'./types.ts\'',
    'src/main.ts': 'import type {Value as Inner} from \'#src/types.ts\'; export {type Literal, type Value} from \'./types.ts\'; function api() {return 1}; namespace api {export type Value<T> = Inner<T>}; export default api',
  })
  const {outputFolder} = await bundil({
    target: root,
    mode: 'production',
  })
  await install(outputFolder)
  await typecheck('import api, {type Literal, type Value} from \'fixture\'; const value: api.Value<number> = {value: api()}; const alias: Value<number> = value; const literal: Literal = \'./types.ts\';')
  const preserved = await bundil({
    target: root,
    mode: 'production',
    dtsStrategy: 'preserve',
  })
  const pkg = await readManifest(preserved.outputFolder)
  expect(await Bun.file(join(preserved.outputFolder, pkg.types!)).text()).not.toContain('#src/')
  expect(preserved.declarationStrategy).toBe('preserve')
}, 30_000)
test('accepts the precompiled build_lib command line and retains relocatable assets, subpaths and declarations', async () => {
  await fixture({exports: {
    '.': {
      types: './types/main.d.ts',
      default: './src/entry.ts',
    },
    './extra': {
      types: './types/extra.d.ts',
      import: './src/extra.js',
    },
  }}, {
    'src/main.js': 'import value from \'../assets/value.js\'; export default value; export const named = \'named\'',
    'src/extra.js': 'export {default} from \'../assets/value.js\'',
    'assets/value.js': '// Remove this comment when optimizing.\nconst value = \'precompiled\'; export default value',
    'assets/data.bin': '\0\u{1}\u{FF}',
    'types/main.d.ts': 'export {default} from \'./extra.js\'; export declare const named: \'named\'',
    'types/extra.d.ts': 'declare const value: \'precompiled\'; export default value',
  })
  const result = await run(workspace, [cli, 'project', '--runtimeEntryFile', 'src/main.js', '--precompiled', '--no-emitDts', '--copyFiles', 'src', '--copyFiles', 'assets', '--copy-files', 'types', '--optimizeCopiedScripts', '--terser-strength', 'aggressive', '--mode', 'production', '--outputFolder', '../dist'])
  expect(result).toEndWith('/dist/fixture/production')
  const installed = await install(result)
  expect(await Bun.file(join(installed, 'assets/value.js')).text()).not.toContain('Remove this comment')
  expect(await Bun.file(join(installed, 'assets/data.bin')).bytes()).toEqual(await Bun.file(join(root, 'assets/data.bin')).bytes())
  expect(await run(consumer, ['-e', 'import value, {named} from \'fixture\'; import extra from \'fixture/extra\'; console.log(value, named, extra)'])).toBe('precompiled named precompiled')
  await typecheck('import value, {named} from \'fixture\'; import extra from \'fixture/extra\'; const values: [\'precompiled\', \'named\', \'precompiled\'] = [value, named, extra];')
}, 30_000)
test('rebuilds only the selected package and mode and keeps the last successful build on failure', async () => {
  await fixture({}, {'src/nested/selected.ts': 'export default 42'})
  const options = {
    target: join(root, 'src/nested/selected.ts'),
    mode: 'development',
  } as const
  const {outputFolder} = await bundil(options)
  const script = Bun.file(join(outputFolder, 'lib.js'))
  const previous = await script.text()
  await rejects(bundil({
    ...options,
    copyFiles: ['../consumer/package.json'],
  }), /inside/u)
  await Bun.write(options.target, 'import missing from \'uninstalled-package\'; export default missing')
  await rejects(bundil(options), /uninstalled-package/u)
  expect(await script.text()).toBe(previous)
  const sibling = join(outputFolder, '../production/keep')
  await Bun.write(sibling, 'other mode')
  await Bun.write(join(outputFolder, 'obsolete.js'), '')
  await Bun.write(options.target, 'export default 84')
  const rebuilt = await bundil(options)
  expect(rebuilt.files).not.toContain('obsolete.js')
  expect(await Bun.file(sibling).text()).toBe('other mode')
})
