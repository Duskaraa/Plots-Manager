import { world } from "@minecraft/server";

/**
 * @typedef {Object} DatabaseOptions
 * @property {boolean} [useCache=true] Whether to keep an in-memory mirror.
 * @property {boolean} [eagerLoad=true] Warm cache from world on startup.
 * @property {(key: string) => void} [validateKey] Optional custom key guard.
 * @property {(value: any) => any} [serialize] Transform before persisting.
 * @property {(raw: any) => any} [deserialize] Transform after reading.
 * @property {string} [separator=":"] Delimiter for namespacing segments.
 */

class Database {
  /**
   * @param {string} name
   * @param {DatabaseOptions} [options]
   */
  constructor(name, options = {}) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("Database name must be a non-empty string");
    }

    this.name = name;
    this.separator = options.separator ?? ":";
    this.useCache = options.useCache ?? true;
    this.eagerLoad = options.eagerLoad ?? true;
    this.validateKey = typeof options.validateKey === "function" ? options.validateKey : null;
    this.serialize = typeof options.serialize === "function" ? options.serialize : (value) => value;
    this.deserialize = typeof options.deserialize === "function" ? options.deserialize : (raw) => raw;

    /** @type {Map<string, any> | null} */
    this.cache = this.useCache ? new Map() : null;
    this.cachePrimed = false;

    if (this.useCache && this.eagerLoad) {
      this.refreshCache();
    }
  }

  /**
   * @param {string} key
   * @param {string} [segment]
   * @returns {string}
   */
  buildId(key, segment) {
    this.ensureValidKey(key, "key");
    if (segment !== undefined) {
      this.ensureValidKey(segment, "segment");
    }
    const pieces = segment ? [this.name, segment, key] : [this.name, key];
    return pieces.join(this.separator);
  }

  /**
   * @param {string} id
   * @returns {{ key: string, segment: string | null } | null}
   */
  parseId(id) {
    const pieces = id.split(this.separator);
    if (pieces[0] !== this.name || pieces.length < 2) return null;
    if (pieces.length === 2) return { segment: null, key: pieces[1] };
    return { segment: pieces[1], key: pieces.slice(2).join(this.separator) };
  }

  /**
   * @param {string}
   * @param {"key" | "segment"}
   */
  ensureValidKey(key, label) {
    if (typeof key !== "string" || key.trim() === "") {
      throw new TypeError(`${label} must be a non-empty string`);
    }
    if (key.includes(this.separator)) {
      throw new Error(`${label} cannot contain the separator '${this.separator}'`);
    }
    if (this.validateKey) this.validateKey(key);
  }

  /**
   * @param {string} [segment]
   * @returns {Array<{ key: string, segment: string | null, value: any }>}
   */
  refreshCache(segment) {
    if (!this.useCache || !this.cache) return [];

    const prefixPieces = segment ? [this.name, segment] : [this.name];
    const prefix = prefixPieces.join(this.separator) + this.separator;
    const loaded = [];

    for (const id of world.getDynamicPropertyIds()) {
      if (!id.startsWith(prefix)) continue;
      const parsed = this.parseId(id);
      if (!parsed) continue;
      const value = this.deserialize(world.getDynamicProperty(id));
      this.cache.set(id, value);
      loaded.push({ ...parsed, value });
    }

    this.cachePrimed = true;
    return loaded;
  }

  /**
   * @param {string} key
   * @param {string} [segment]
   * @returns {any}
   */
  get(key, segment) {
    const id = this.buildId(key, segment);
    if (this.useCache && this.cache?.has(id)) {
      return this.cache.get(id);
    }

    const raw = world.getDynamicProperty(id);
    if (raw === undefined) return undefined;

    const value = this.deserialize(raw);
    if (this.useCache && this.cache) this.cache.set(id, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {string} [segment]
   */
  set(key, value, segment) {
    const id = this.buildId(key, segment);
    const payload = this.serialize(value);
    world.setDynamicProperty(id, payload);
    if (this.useCache && this.cache) this.cache.set(id, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {string} [segment]
   */
  delete(key, segment) {
    const id = this.buildId(key, segment);
    world.setDynamicProperty(id, undefined);
    if (this.useCache && this.cache) this.cache.delete(id);
  }

  /**
   * @param {string} key
   * @param {string} [segment]
   * @returns {boolean}
   */
  has(key, segment) {
    const id = this.buildId(key, segment);
    if (this.useCache && this.cache?.has(id)) return true;
    return world.getDynamicProperty(id) !== undefined;
  }

  /**
   * @template T
   * @param {string} key
   * @param {(current: any) => T} updater
   * @param {string} [segment]
   * @returns {T}
   */
  update(key, updater, segment) {
    if (typeof updater !== "function") {
      throw new TypeError("Updater must be a function");
    }
    const current = this.get(key, segment);
    const next = updater(current);
    if (next === undefined) {
      this.delete(key, segment);
      return next;
    }
    return this.set(key, next, segment);
  }

  /**
   * @param {string} [segment]
   * @returns {Array<{ key: string, segment: string | null, value: any }>}
   */
  entries(segment) {
    if (this.useCache) {
      this.refreshCache(segment);
      if (this.cache) {
        const prefixPieces = segment ? [this.name, segment] : [this.name];
        const prefix = prefixPieces.join(this.separator) + this.separator;
        const result = [];
        for (const [id, value] of this.cache.entries()) {
          if (!id.startsWith(prefix)) continue;
          const parsed = this.parseId(id);
          if (!parsed) continue;
          result.push({ ...parsed, value });
        }
        return result;
      }
    }

    const ids = this.listIds(segment);
    return ids
      .map((id) => {
        const parsed = this.parseId(id);
        const value = this.deserialize(world.getDynamicProperty(id));
        return parsed ? { ...parsed, value } : null;
      })
      .filter((entry) => entry !== null);
  }

  /**
   * @param {string} [segment]
   */
  clear(segment) {
    const ids = this.listIds(segment);
    for (const id of ids) {
      world.setDynamicProperty(id, undefined);
      if (this.useCache && this.cache) this.cache.delete(id);
    }
  }

  /**
   * @param {string} [segment]
   * @returns {string[]}
   */
  listIds(segment) {
    const prefixPieces = segment ? [this.name, segment] : [this.name];
    const prefix = prefixPieces.join(this.separator) + this.separator;
    return world.getDynamicPropertyIds().filter((id) => id.startsWith(prefix));
  }
}

export default Database;
