# bundil

Pack an ESM library into a directory you can publish to npm. Bundil runs on Bun, uses Rolldown for JavaScript and emits consumer-ready TypeScript declarations. It follows the package layout and command-line conventions of `build_lib`.

## Migrate a package

```sh
bun add --dev bundil
```

Replace the executable in the existing build script. For example, `build_lib --terser-strength max` becomes:

```json
{
  "scripts": {
    "build": "bundil --terser-strength max"
  }
}
```

Run `bun run build`. For a package named `make-argv`, the publish directory is `dist/make-argv/production/`:

```text
lib.js         ESM entry
lib.d.ts       public types (when bundled)
package.json   publish manifest
README.md      from readme.md, if present
LICENSE        from license.txt or LICENSE, if present
```

Run `bun pm pack` or `bun publish` **inside that directory**. Build scripts, development dependencies and source-only import aliases are omitted from the publish manifest. Metadata such as `sideEffects`, `engines`, `funding` and `peerDependenciesMeta` is retained. Exact runtime dependency versions get a caret unless you pass `--no-lax-versions`; ranges, tags and npm aliases are kept as written.

## Entry points

- `bundil` builds the current package. The optional target can be a directory, its `package.json` or a specific source file. Relative output and copy paths are resolved from the target package, regardless of the invoking directory.
- For the root entry, bundil uses the string, `import` or `default` target from `exports`, falling back to `src/main.ts`. A source-file target overrides it. Concrete JS/TS subpath exports get their own runtime and type entries. Rolldown resolves package `imports` such as `#src/*` during the build.
- A declared `bin` is built alongside the library. Without one, `src/cli.ts` is picked up automatically. The primary executable is `cli.js`; its shebang is preserved, defaulting to `#!/usr/bin/env bun` when absent.
- Regular, optional and peer dependencies (including subpaths) stay external by default. `--bundle` inlines regular dependencies; peers and optional dependencies stay external. A dependency still referenced by the published types stays in the manifest.

CLI-only packages need only a `bin` entry (or a `src/cli.ts` or `src/cli.js` file); they do not get a fabricated library export. Declaration-only packages can specify `types` or a types-only conditional export, including subpaths. They produce declaration files without JavaScript entry points.

## Build modes and declarations

Production is the default, matching the configured `build_lib` command. `--mode development` or `NODE_ENV=development` produces a readable build with `private: true` under `dist/<name>/development/`. Rebuilding replaces only the selected package and mode.

For source builds, Terser runs in `renderChunk`, then Rolldown applies its native Oxc minifier. `--terser-strength aggressive` and `max` opt into the corresponding unsafe compressor optimizations from `build_lib`. `false` skips Terser; `auto` enables it only in production.

Declarations are generated in production by default. Bundil reads the target’s `tsconfig.json`, emits the public declaration graph with TypeScript and bundles it with `rolldown-plugin-dts`. If the bundled types fail to build or validate, `--dts-strategy auto` ships validated individual declarations instead. The manifest always points to the selected result. Use `--dts-strategy bundle` to require bundling, `--dts-strategy preserve` to keep the graph or `--no-emit-dts` to skip generation.

## Precompiled packages

Use `--precompiled` after a Vite or other multi-entry build. The runtime entry keeps its original package-relative path so its imports, workers and asset URLs still resolve. `lib.js` re-exports its names and its default export when present. Use `--copy-files` once per additional file or directory that belongs in the package.

```sh
bundil out/intermediate --precompiled --runtimeEntryFile src/main.js --copyFiles assets --terser-strength max --outputFolder ../../dist
```

For an intermediate package that already supplies declarations and subpath exports:

```sh
bundil out/intermediate/my-lib --precompiled --runtime-entry-file src/main.js --no-emit-dts --copy-files src --copy-files assets --copy-files types --optimize-copied-scripts --mode production
```

Copied files retain their bytes by default. `--optimize-copied-scripts` applies the selected Terser strength to copied JavaScript as well. Concrete export targets must exist in the finished package.

## Library API

```ts
import bundil from 'bundil'

const {outputFolder, files, declarationStrategy} = await bundil({
  target: '../make-argv',
  mode: 'production',
  terserStrength: 'max',
})
```

`outputFolder` is absolute; `files` contains sorted package-relative paths. `declarationStrategy` is `bundle`, `preserve` or `undefined` when generation was skipped. `BundilOptions` also accepts Rolldown input `plugins` and compile-time `define` replacements for the runtime build. Run `bunx bundil --help` for the CLI options. Both kebab-case and the `build_lib` camelCase spellings are accepted.
