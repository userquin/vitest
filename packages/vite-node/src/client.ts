import { builtinModules, createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import vm from 'vm'
import { dirname, resolve } from 'pathe'
import { normalizeId, slash, toFilePath } from './utils'
import type { ModuleCache, ViteNodeRunnerOptions } from './types'

export class ViteNodeRunner {
  root: string

  externalCache: Map<string, string | Promise<false | string>>
  moduleCache: Map<string, ModuleCache>

  constructor(public options: ViteNodeRunnerOptions) {
    this.root = options.root || process.cwd()
    this.moduleCache = options.moduleCache || new Map()
    this.externalCache = new Map<string, string | Promise<false | string>>()
    builtinModules.forEach(m => this.externalCache.set(m, m))
  }

  async run(file: string) {
    return await this.cachedRequest(`/@fs/${slash(resolve(file))}`, [])
  }

  async cachedRequest(rawId: string, callstack: string[]) {
    const id = normalizeId(rawId, this.options.base)
    const fsPath = toFilePath(id, this.root)

    if (this.moduleCache.get(fsPath)?.promise)
      return this.moduleCache.get(fsPath)?.promise

    const promise = this.directRequest(id, fsPath, callstack)
    this.setCache(fsPath, { promise })

    return await promise
  }

  async directRequest(id: string, fsPath: string, callstack: string[]) {
    callstack = [...callstack, id]
    const request = async(dep: string) => {
      if (callstack.includes(dep)) {
        const cacheKey = toFilePath(dep, this.root)
        if (!this.moduleCache.get(cacheKey)?.exports)
          throw new Error(`Circular dependency detected\nStack:\n${[...callstack, dep].reverse().map(p => `- ${p}`).join('\n')}`)
        return this.moduleCache.get(cacheKey)!.exports
      }
      return this.cachedRequest(dep, callstack)
    }

    if (this.options.requestStubs && id in this.options.requestStubs)
      return this.options.requestStubs[id]

    const { code: transformed, externalize } = await this.options.fetchModule(id)
    if (externalize) {
      const mod = await interpretedImport(externalize, this.options.interpretDefault ?? true)
      this.setCache(fsPath, { exports: mod })
      return mod
    }

    if (transformed == null)
      throw new Error(`failed to load ${id}`)

    // disambiguate the `<UNIT>:/` on windows: see nodejs/node#31710
    const url = pathToFileURL(fsPath).href
    const exports: any = {}

    this.setCache(fsPath, { code: transformed, exports })

    const __filename = fileURLToPath(url)
    const moduleProxy = {
      set exports(value) {
        exportAll(exports, value)
        exports.default = value
      },
      get exports() {
        return exports.default
      },
    }

    const context = this.prepareContext({
      // esm transformed by Vite
      __vite_ssr_import__: request,
      __vite_ssr_dynamic_import__: request,
      __vite_ssr_exports__: exports,
      __vite_ssr_exportAll__: (obj: any) => exportAll(exports, obj),
      __vite_ssr_import_meta__: { url },

      // cjs compact
      require: createRequire(url),
      exports,
      module: moduleProxy,
      __filename,
      __dirname: dirname(__filename),
    })

    const fn = vm.runInThisContext(`async (${Object.keys(context).join(',')})=>{{${transformed}\n}}`, {
      filename: fsPath,
      lineOffset: 0,
    })

    await fn(...Object.values(context))

    return exports
  }

  prepareContext(context: Record<string, any>) {
    return context
  }

  setCache(id: string, mod: Partial<ModuleCache>) {
    if (!this.moduleCache.has(id))
      this.moduleCache.set(id, mod)
    else
      Object.assign(this.moduleCache.get(id), mod)
  }
}

function hasNestedDefault(target: any) {
  return '__esModule' in target && target.__esModule && 'default' in target.default
}

function proxyMethod(name: 'get' | 'set' | 'has' | 'deleteProperty', tryDefault: boolean) {
  return function(target: any, key: string | symbol, ...args: [any?, any?]) {
    const result = Reflect[name](target, key, ...args)
    if (typeof target.default !== 'object')
      return result
    if ((tryDefault && key === 'default') || typeof result === 'undefined')
      return Reflect[name](target.default, key, ...args)
    return result
  }
}

async function interpretedImport(path: string, interpretDefault: boolean) {
  const mod = await import(path)

  if (interpretDefault && 'default' in mod) {
    const tryDefault = hasNestedDefault(mod)
    return new Proxy(mod, {
      get: proxyMethod('get', tryDefault),
      set: proxyMethod('set', tryDefault),
      has: proxyMethod('has', tryDefault),
      deleteProperty: proxyMethod('deleteProperty', tryDefault),
    })
  }

  return mod
}

function exportAll(exports: any, sourceModule: any) {
  // eslint-disable-next-line no-restricted-syntax
  for (const key in sourceModule) {
    if (key !== 'default') {
      try {
        Object.defineProperty(exports, key, {
          enumerable: true,
          configurable: true,
          get() { return sourceModule[key] },
        })
      }
      catch (_err) { }
    }
  }
}
