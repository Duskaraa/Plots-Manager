import { system, world } from "@minecraft/server";

/** @typedef {import("@minecraft/server").ItemUseBeforeEvent} ItemUse */
/** @typedef {import("@minecraft/server").PlayerInventorySlotChangeAfterEvent} PlayerInventoryItemChange */
/** @typedef {import("@minecraft/server").PlayerInteractWithBlockBeforeEvent} PlayerInteractWithBlock */
/** @typedef {import("@minecraft/server").PlayerBreakBlockBeforeEvent} PlayerBreakBlock */
/** @typedef {import("@minecraft/server").PlayerJoinAfterEvent} PlayerJoin */
/** @typedef {import("@minecraft/server").PlayerLeaveBeforeEvent} PlayerLeave */
/** @typedef {import("@minecraft/server").EntitySpawnAfterEvent} EntitySpawn */
/** @typedef {import("@minecraft/server").PlayerSpawnAfterEvent} PlayerSpawn */
/** @typedef {{ data: any, timestamp: number, isWatchdog: boolean }} ShutdownEvent */

/**
 * @typedef {"worldLoad" | "ItemUse" | "PlayerInventoryItemChange" | "PlayerInteractWithBlock" | "PlayerBreakBlock" | "PlayerJoin" | "PlayerLeave" | "EntitySpawn" | "PlayerSpawn" | "ShutdownEvent" | "*"} EventBusEventName
 */

/**
 * @typedef {Object} EventBusPayloads
 * @property {*} worldLoad
 * @property {ItemUse} ItemUse
 * @property {PlayerInventoryItemChange} PlayerInventoryItemChange
 * @property {PlayerInteractWithBlock} PlayerInteractWithBlock
 * @property {PlayerBreakBlock} PlayerBreakBlock
 * @property {PlayerJoin} PlayerJoin
 * @property {PlayerLeave} PlayerLeave
 * @property {EntitySpawn} EntitySpawn
 * @property {PlayerSpawn} PlayerSpawn
 * @property {ShutdownEvent} Shutdown
 * @property {*} *
 */

/** @typedef {{ beforeLoad?: boolean }} EventBusModuleOptions */

class EventBus {
  static events = new Map();
  static maxListeners = 1000;
  static initialized = false;
  static worldReady = false;
  static moduleQueue = [];
  static importedModules = new Set();
  static beforeModulesLoaded = false;
  static afterModulesLoaded = false;
  static get listenersSnapshot() {
    const copy = new Map();
    for (const [name, set] of this.events.entries()) copy.set(name, new Set(set));
    return copy;
  }
  /**
   * @param {EventBusEventName | string} event
   * @param {(data: any, evName?: EventBusEventName | string) => void} callback
   * @returns {() => void} unsubscribe
   */
  /**
   * @template {EventBusEventName} K
   * @param {K} event
   * @param {(data: EventBusPayloads[K], evName?: K) => void} callback
   * @returns {() => void} unsubscribe
   */
  static on(event, callback) {
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    if (typeof callback !== "function") throw new TypeError("Callback must be a function");
    const set = this.events.get(event) ?? new Set();
    set.add(callback);
    this.events.set(event, set);
    if (set.size > this.maxListeners) {
      console.warn(`EventBus: possible listener leak. ${set.size} listeners for "${event}"`);
    }
    return () => this.off(event, callback);
  }
  /**
   * @param {EventBusEventName | string} event
   * @param {(data: any, evName?: EventBusEventName | string) => void} callback
   * @returns {() => void} unsubscribe
   */
  /**
   * @template {EventBusEventName} K
   * @param {K} event
   * @param {(data: EventBusPayloads[K], evName?: K) => void} callback
   * @returns {() => void} unsubscribe
   */
  static once(event, callback) {
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    if (typeof callback !== "function") throw new TypeError("Callback must be a function");
    let unsubCalled = false;
    const wrapper = (data, evName) => {
      if (unsubCalled) return;
      unsubCalled = true;
      try {
        callback(data, evName);
      } finally {
        this.off(event, wrapper);
      }
    };
    return this.on(event, wrapper);
  }
  /**
   * @param {EventBusEventName | string | null} [event]
   * @param {(data: any) => void} [callback]
   */
  static off(event = null, callback) {
    if (event === null) {
      this.events.clear();
      return;
    }
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    const set = this.events.get(event);
    if (!set) return;
    if (callback === undefined) {
      this.events.delete(event);
      return;
    }
    if (typeof callback !== "function") throw new TypeError("Callback must be a function");
    set.delete(callback);
    if (set.size === 0) this.events.delete(event);
  }
  /**
   * @param {EventBusEventName | string} event
   * @param {any} data
   */
  static emit(event, data) {
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    const specific = this.events.get(event);
    const wildcard = this.events.get("*");
    if (!specific && !wildcard) return;
    const toCall = new Set();
    if (specific) specific.forEach((cb) => toCall.add(cb));
    if (wildcard) wildcard.forEach((cb) => toCall.add(cb));
    for (const cb of toCall) {
      try {
        const callWithEventName = wildcard?.has(cb) && (!specific || !specific.has(cb));
        if (callWithEventName) {
          cb(data, event);
        } else {
          cb(data);
        }
      } catch (err) {
        try {
          console.error(`Error in handler for event "${event}":`, err);
        } catch { }
      }
    }
  }
  /**
   * @param {EventBusEventName | string} event
   * @param {any} data
   */
  static async emitAsync(event, data) {
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    const specific = this.events.get(event);
    const wildcard = this.events.get("*");
    if (!specific && !wildcard) return [];
    const toCall = new Set();
    if (specific) specific.forEach((cb) => toCall.add(cb));
    if (wildcard) wildcard.forEach((cb) => toCall.add(cb));
    const tasks = Array.from(toCall, (cb) => {
      const callWithEventName = wildcard?.has(cb) && (!specific || !specific.has(cb));
      try {
        const result = callWithEventName ? cb(data, event) : cb(data);
        return Promise.resolve(result);
      } catch (err) {
        return Promise.reject(err);
      }
    });
    return Promise.allSettled(tasks);
  }
  /**
   * @param {EventBusEventName | string} event
   * @returns {Array<Function>}
   */
  static listeners(event) {
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    const set = this.events.get(event);
    return set ? Array.from(set) : [];
  }
  /**
   * @param {EventBusEventName | string} event
   */
  static listenerCount(event) {
    if (typeof event !== "string") throw new TypeError("Event name must be a string");
    const set = this.events.get(event);
    return set ? set.size : 0;
  }
  static eventNames() {
    return Array.from(this.events.keys());
  }
  static clearListeners(event) {
    this.off(event ?? null);
  }
  /**
   * Queue a module import. By default modules load after world load.
   * Pass { beforeLoad: true } to load immediately (critical bootstrapping code).
   * Returns an unsubscribe function to drop the queued module if needed.
   */
  /**
   * Queue a module import. By default modules load after world load.
   * Pass { beforeLoad: true } to load immediately.
   * @param {string} path
   * @param {EventBusModuleOptions} [options]
   * @returns {() => void} unsubscribe
   */
  static registerModule(path, options) {
    if (typeof path !== "string" || path.trim() === "") {
      throw new TypeError("Module path must be a non-empty string");
    }
    const phase = options?.beforeLoad ? "before" : "after";
    const record = { path, phase };
    this.moduleQueue.push(record);
    if ((phase === "before" && this.beforeModulesLoaded) || (phase === "after" && this.afterModulesLoaded)) {
      void this.importModule(path);
    }
    return () => {
      const idx = this.moduleQueue.indexOf(record);
      if (idx >= 0) this.moduleQueue.splice(idx, 1);
    };
  }
  static initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.setupWatchdogHandler();
    void this.importPhase("before");
    world.afterEvents.worldLoad.subscribe((data) => {
      if (this.worldReady) return;
      this.worldReady = true;
      try {
        this.attachMinecraftEvents();
        this.emit("worldLoad", data);
        void this.importPhase("after");
      } catch (err) {
        console.error("Error in EventBus.initialize worldLoad handler:", err);
      }
    });
  }
  static setupWatchdogHandler() {
    try {
      const watchdog = system?.beforeEvents?.watchdogTerminate;
      if (watchdog && typeof watchdog.subscribe === "function") {
        watchdog.subscribe((data) => {
          try {
            data.cancel = true;
          } catch { }
          try {
            console.warn(`[Watchdog] Canceled critical exception of type '${data?.terminateReason ?? "unknown"}'.`);
          } catch { }
          try {
            this.emit("shutdown", { data, timestamp: Date.now(), isWatchdog: true });
          } catch (err) {
            console.error("Error emitting shutdown from watchdog", err);
          }
        });
      }
    } catch (err) {
      console.log("Watchdog setup non-fatal:", err);
    }
  }
  static attachMinecraftEvents() {
    const safeSubscribe = (name, source) => {
      if (!source || typeof source.subscribe !== "function") return;
      source.subscribe((ev) => this.emit(name, ev));
    };
    const hooks = [
      { name: "Item", source: world.beforeEvents?.itemUse },
      { name: "PlayerInventoryItemChange", source: world.afterEvents?.playerInventoryItemChange },
      { name: "PlayerInteractWithBlock", source: world.beforeEvents?.playerInteractWithBlock },
      { name: "PlayerBreakBlock", source: world.beforeEvents?.playerBreakBlock },
      { name: "PlayerJoin", source: world.afterEvents?.playerJoin },
      { name: "PlayerLeave", source: world.beforeEvents?.playerLeave },
      { name: "EntitySpawn", source: world.afterEvents?.entitySpawn },
      { name: "PlayerSpawn", source: world.afterEvents?.playerSpawn },
    ];
    hooks.forEach(({ name, source }) => safeSubscribe(name, source));
  }
  static async importPhase(phase) {
    const pending = this.moduleQueue.filter((m) => m.phase === phase);
    if (phase === "before") this.beforeModulesLoaded = true;
    if (phase === "after") this.afterModulesLoaded = true;
    if (pending.length === 0) return;
    const results = await Promise.allSettled(pending.map((m) => this.importModule(m.path)));
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.error(`EventBus: ${failures.length} module import(s) failed during ${phase} phase.`);
    }
  }
  static async importModule(path) {
    if (this.importedModules.has(path)) return;
    this.importedModules.add(path);
    try {
      await import(path);
    } catch (err) {
      console.error(`EventBus: failed to import module '${path}'.`, err);
    }
  }
}
export default EventBus;
EventBus.initialize();
